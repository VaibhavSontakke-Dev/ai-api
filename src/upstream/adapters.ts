/** Anti-corruption layer: raw upstream shapes stop here. Everything is validated before the rest of the code sees it. */
import { parse as parseCsv } from 'csv-parse/sync';
import { XMLParser } from 'fast-xml-parser';
import { z } from 'zod';
import type { Config } from '../config.ts';
import { log } from '../context.ts';
import { Problem } from '../problem.ts';
import type { Db } from '../store/db.ts';
import { UpstreamClient, UpstreamError, type FailureReason } from './resilience.ts';

export type Tier = 'Platinum' | 'Gold' | 'Silver' | 'Standard';
export type SourceStatus = { status: 'fresh' | 'stale' | 'unavailable'; asOf?: string | null; reason?: FailureReason | 'no_data' };
export type Note = { code: 'tier_conflict' | 'renewal_conflict' | 'alias_mapped' | 'missing_in_feed'; message: string };
export type Entitlement = { id: string; name: string; tier: Tier; contractEnd: string | null; renewal: string | null; arrUsd: number; notes: Note[] };
export type Usage = { month: string; protectedTb: number; apiCalls: number; activeUsers: number };
export type Comment = { id: string; author: string; body: string; at: string };
export type Case = {
  id: string; customerId: string; priority: 'P1' | 'P2' | 'P3' | 'P4';
  status: 'open' | 'in_progress' | 'waiting_on_customer' | 'resolved' | 'closed';
  openedAt: string; subject: string; comments: Comment[]; version: number;
  escalation: { level: 'L2' | 'L3'; reason: 'sla_breach_risk' | 'customer_impact' | 'security_concern' | 'executive_request'; at: string } | null;
};

export type CaseFilter = { accountIds?: string[]; notAccountIds?: string[]; priority?: string[]; status?: string[]; escalated?: boolean; openedBefore?: string };
export type CaseSort = 'openedAt' | '-openedAt' | 'priority';
export type CaseKey = { key: string; id: string };
export const caseKey = (sort: CaseSort, c: Case): string => (sort === 'priority' ? c.priority : new Date(c.openedAt).toISOString());
export const compareKeys = (sort: string, a: CaseKey, b: CaseKey): number =>
  (a.key !== b.key ? (a.key < b.key ? -1 : 1) * (sort === '-openedAt' ? -1 : 1) : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export const CUSTOMER_ID = /^ACC-\d{3,6}$/;
const zDate = z.iso.date();
const zTier = z.enum(['Platinum', 'Gold', 'Silver', 'Standard']);

const unwrap = (err: unknown): FailureReason => (err instanceof UpstreamError ? err.reason : 'upstream_error');
const ok = (name: string, r: { status: number; text: string }): string => {
  if (r.status !== 200) throw new UpstreamError(name, 'upstream_error');
  return r.text;
};
const json = (name: string, text: string): unknown => {
  try { return JSON.parse(text); } catch { throw new UpstreamError(name, 'upstream_error'); }
};

/** Short cache plus a persisted last-known-good copy. A failed refresh serves the copy and says it is stale. */
class Snapshots {
  private readonly db: Db;
  private readonly config: Config;
  private readonly inflight = new Map<string, Promise<{ data: unknown; source: SourceStatus }>>();

  constructor(db: Db, config: Config) {
    this.db = db;
    this.config = config;
  }

  async load<T>(key: string, fetcher: () => Promise<T>): Promise<{ data: T | null; source: SourceStatus }> {
    const row = this.db.prepare('SELECT body, fetched_at FROM upstream_snapshots WHERE key = ?').get(key) as { body: string; fetched_at: number } | undefined;
    if (row && Date.now() - row.fetched_at < this.config.cacheTtlMs) {
      return { data: JSON.parse(row.body) as T, source: { status: 'fresh', asOf: new Date(row.fetched_at).toISOString() } };
    }
    let pending = this.inflight.get(key);
    if (!pending) {
      pending = this.refresh(key, fetcher, row).finally(() => this.inflight.delete(key));
      this.inflight.set(key, pending);
    }
    return pending as Promise<{ data: T | null; source: SourceStatus }>;
  }

  private async refresh<T>(key: string, fetcher: () => Promise<T>, row: { body: string; fetched_at: number } | undefined): Promise<{ data: T | null; source: SourceStatus }> {
    try {
      const data = await fetcher();
      const now = Date.now();
      this.db.prepare('INSERT INTO upstream_snapshots VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET body = excluded.body, fetched_at = excluded.fetched_at').run(key, JSON.stringify(data), now);
      return { data, source: { status: 'fresh', asOf: new Date(now).toISOString() } };
    } catch (err) {
      const reason = unwrap(err);
      log.warn({ key, reason, err: (err as Error).message }, 'refresh failed');
      if (row && Date.now() - row.fetched_at < this.config.staleMs) {
        return { data: JSON.parse(row.body) as T, source: { status: 'stale', asOf: new Date(row.fetched_at).toISOString(), reason } };
      }
      return { data: null, source: { status: 'unavailable', asOf: null, reason } };
    }
  }
}

type CsvRow = { id: string; name: string; tier: Tier; contractEnd: string; arrUsd: number };
type FeedRow = { tier: Tier; renewal: string };

export class Upstreams {
  readonly caseClient: UpstreamClient;
  readonly csvClient: UpstreamClient;
  readonly xmlClient: UpstreamClient;
  readonly warehouseClient: UpstreamClient;
  private readonly db: Db;
  private readonly snapshots: Snapshots;
  private readonly reported = new Set<string>();
  private readonly onDataQuality: (message: string, resource: string) => void;

  constructor(config: Config, db: Db, onDataQuality: (message: string, resource: string) => void) {
    this.caseClient = new UpstreamClient('cases', config);
    this.csvClient = new UpstreamClient('entitlement_csv', config);
    this.xmlClient = new UpstreamClient('entitlement_xml', config);
    this.warehouseClient = new UpstreamClient('warehouse', config);
    this.db = db;
    this.snapshots = new Snapshots(db, config);
    this.onDataQuality = onDataQuality;
  }

  circuits(): Record<string, string> {
    return Object.fromEntries([this.caseClient, this.csvClient, this.xmlClient, this.warehouseClient].map((c) => [c.name, c.breaker.state]));
  }

  // --- Entitlements --------------------------------------------------------------------------------------------

  private quarantine(id: string, why: string): void {
    if (this.reported.has(`${id}:${why}`)) return;
    this.reported.add(`${id}:${why}`);
    log.warn({ id, why }, 'entitlement row quarantined');
    this.onDataQuality(why, id);
  }

  private async fetchCsv(): Promise<CsvRow[]> {
    const text = ok('entitlement_csv', await this.csvClient.request('/entitlements/export.csv'));
    let raw: Record<string, string>[];
    try {
      raw = parseCsv(text, { columns: true, trim: true, skip_empty_lines: true, bom: true }) as Record<string, string>[];
    } catch {
      throw new UpstreamError('entitlement_csv', 'upstream_error');
    }
    const schema = z.object({ account_id: z.string().min(1), name: z.string().min(1), support_tier: zTier, contract_end: zDate, arr_usd: z.string().regex(/^\d+$/).transform(Number) });
    const rows: CsvRow[] = [];
    for (const r of raw) {
      const p = schema.safeParse(r);
      if (!p.success) { this.quarantine(r.account_id ?? '?', 'invalid row'); continue; }
      rows.push({ id: p.data.account_id, name: p.data.name, tier: p.data.support_tier, contractEnd: p.data.contract_end, arrUsd: p.data.arr_usd });
    }
    if (rows.length === 0) throw new UpstreamError('entitlement_csv', 'upstream_error'); // an empty export is a failure, not "no customers"
    return rows;
  }

  private async fetchXml(): Promise<Record<string, FeedRow>> {
    const text = ok('entitlement_xml', await this.xmlClient.request('/entitlements/feed.xml'));
    const schema = z.object({ accounts: z.object({ account: z.array(z.object({ '@_id': z.string(), tier: zTier, renewal: zDate })).min(1) }) });
    let doc: unknown;
    try {
      // Entities stay unexpanded, so a hostile feed cannot use entity expansion.
      doc = new XMLParser({ ignoreAttributes: false, processEntities: false, parseTagValue: false, isArray: (n) => n === 'account' }).parse(text);
    } catch {
      throw new UpstreamError('entitlement_xml', 'upstream_error');
    }
    const p = schema.safeParse(doc);
    if (!p.success) throw new UpstreamError('entitlement_xml', 'upstream_error');
    return Object.fromEntries(p.data.accounts.account.map((a) => [a['@_id'], { tier: a.tier, renewal: a.renewal }]));
  }

  /**
   * Merge rules: the CSV is the contract master (name, ARR, contract end). The XML feed is newer, so it wins for tier
   * and renewal, and any disagreement is reported. Ids map only through the reviewed crosswalk: padding ACC-77 to
   * ACC-077 would hand Acme's ARR to Zenith Labs.
   */
  async entitlements(): Promise<{ map: Map<string, Entitlement> | null; source: SourceStatus }> {
    const [csv, xml] = await Promise.all([
      this.snapshots.load('entitlement_csv', () => this.fetchCsv()),
      this.snapshots.load('entitlement_xml', () => this.fetchXml()),
    ]);
    if (!csv.data) return { map: null, source: csv.source };
    const aliases = new Map((this.db.prepare("SELECT source_id, customer_id FROM account_aliases WHERE source = 'entitlement_csv'").all() as { source_id: string; customer_id: string }[]).map((a) => [a.source_id, a.customer_id]));
    const map = new Map<string, Entitlement>();
    for (const r of csv.data) {
      const id = aliases.get(r.id) ?? (CUSTOMER_ID.test(r.id) ? r.id : null);
      if (!id) { this.quarantine(r.id, 'unmapped account id'); continue; }
      if (map.has(id)) { this.quarantine(r.id, `duplicate of ${id}`); continue; }
      const feed = xml.data?.[id];
      const notes: Note[] = [];
      if (id !== r.id) notes.push({ code: 'alias_mapped', message: `Export id ${r.id} mapped by the reviewed crosswalk.` });
      if (!feed) notes.push({ code: 'missing_in_feed', message: 'Not in the XML feed; tier and renewal come from the contract export.' });
      else {
        if (feed.tier !== r.tier) notes.push({ code: 'tier_conflict', message: `Feed says ${feed.tier}, export says ${r.tier}; feed used.` });
        if (feed.renewal !== r.contractEnd) notes.push({ code: 'renewal_conflict', message: `Feed renewal ${feed.renewal} differs from contract end ${r.contractEnd}; feed used.` });
      }
      map.set(id, { id, name: r.name, tier: feed?.tier ?? r.tier, contractEnd: r.contractEnd, renewal: feed?.renewal ?? r.contractEnd, arrUsd: r.arrUsd, notes });
    }
    // Report the worse of the two, so a missing or old feed is never presented as fresh.
    if (csv.source.status !== 'fresh') return { map, source: csv.source };
    if (xml.source.status === 'fresh') return { map, source: csv.source };
    return { map, source: { status: 'stale', asOf: xml.source.asOf ?? null, ...(xml.source.reason && { reason: xml.source.reason }) } };
  }

  // --- Usage ---------------------------------------------------------------------------------------------------

  async usage(customerId: string): Promise<{ data: Usage | null; source: SourceStatus }> {
    const schema = z.object({ data: z.array(z.object({ month: z.string().regex(/^\d{4}-\d{2}$/), protected_tb: z.number(), api_calls: z.number().int(), active_users: z.number().int() })) });
    const r = await this.snapshots.load<Usage[]>(`usage:${customerId}`, async () => {
      const text = ok('warehouse', await this.warehouseClient.request('/warehouse/statements', {
        method: 'POST', readOnly: true,
        body: JSON.stringify({ statement: 'SELECT month, protected_tb, api_calls, active_users FROM usage_monthly WHERE account_id = ? ORDER BY month DESC LIMIT 1', bindings: [customerId] }),
      }));
      const p = schema.safeParse(json('warehouse', text));
      if (!p.success) throw new UpstreamError('warehouse', 'upstream_error');
      return p.data.data.map((u) => ({ month: u.month, protectedTb: u.protected_tb, apiCalls: u.api_calls, activeUsers: u.active_users }));
    });
    if (r.data && r.data.length === 0) return { data: null, source: { ...r.source, reason: 'no_data' } };
    return { data: r.data?.[0] ?? null, source: r.source };
  }

  // --- Cases ---------------------------------------------------------------------------------------------------

  private static readonly rawCase = z.object({
    id: z.string().regex(/^CS-\d{3,9}$/), accountId: z.string().regex(CUSTOMER_ID), priority: z.enum(['P1', 'P2', 'P3', 'P4']),
    status: z.enum(['open', 'in_progress', 'waiting_on_customer', 'resolved', 'closed']), openedAt: z.iso.datetime(), subject: z.string(),
    comments: z.array(z.object({ id: z.string(), author: z.string(), body: z.string(), at: z.iso.datetime() })).default([]),
    version: z.number().int(),
    escalation: z.object({ level: z.enum(['L2', 'L3']), reason: z.enum(['sla_breach_risk', 'customer_impact', 'security_concern', 'executive_request']), at: z.iso.datetime() }).nullish(),
  });

  private parseCase(raw: unknown): Case | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    // The source mixes `Status` and `status`, `Comments` and `comments`.
    const p = Upstreams.rawCase.safeParse({ ...r, status: r.status ?? r.Status, comments: r.comments ?? r.Comments });
    if (!p.success) { this.quarantine(String(r.id), 'invalid case record'); return null; }
    const { accountId, escalation, ...rest } = p.data;
    return { ...rest, customerId: accountId, escalation: escalation ?? null };
  }

  private fail(err: unknown): never {
    if (err instanceof UpstreamError) {
      throw new Problem('upstream-unavailable', `The ${err.source} system did not answer.`, { source: err.source }, { 'Retry-After': '10' });
    }
    throw err;
  }

  /**
   * Cases in order, fetched a page at a time, so the caller stops reading when it has enough. Records that fail
   * validation come back as null. The order is checked: a page built on an unordered answer would lose cases.
   */
  async* streamCases(filter: CaseFilter, sort: CaseSort, after: CaseKey | null, pageSize: number): AsyncGenerator<Case | null> {
    let previous = after;
    try {
      for (let offset = 0; ; offset += pageSize) {
        const body = json('cases', ok('cases', await this.caseClient.request('/case-system/cases/query', {
          method: 'POST', readOnly: true, body: JSON.stringify({ ...filter, sort, ...(after && { after }), offset, limit: pageSize }),
        }))) as { records?: unknown[]; done?: boolean };
        if (!Array.isArray(body.records)) throw new UpstreamError('cases', 'upstream_error');
        for (const raw of body.records) {
          const c = this.parseCase(raw);
          if (c) {
            const key = { key: caseKey(sort, c), id: c.id };
            if (previous && compareKeys(sort, previous, key) >= 0) throw new UpstreamError('cases', 'upstream_error');
            previous = key;
          }
          yield c;
        }
        // An empty page that is not the last one would loop for ever.
        if (body.done || body.records.length === 0) return;
      }
    } catch (err) { this.fail(err); }
  }

  async getCase(id: string): Promise<Case | null> {
    try {
      const r = await this.caseClient.request(`/case-system/cases/${encodeURIComponent(id)}`);
      if (r.status === 404) return null;
      const c = this.parseCase(json('cases', ok('cases', r)));
      if (!c) throw new UpstreamError('cases', 'upstream_error');
      return c;
    } catch (err) { return this.fail(err); }
  }

  private async write(path: string, body: unknown, key: string, expectedVersion: number | null): Promise<unknown> {
    try {
      const r = await this.caseClient.request(path, {
        method: 'POST', body: JSON.stringify(body),
        headers: { 'Idempotency-Key': key, ...(expectedVersion !== null && { 'X-Expected-Version': String(expectedVersion) }) },
      });
      if (r.status === 404) throw new Problem('not-found');
      if (r.status === 409) throw new Problem('version-mismatch', 'The case changed since you read it. Read it again and retry.');
      return json('cases', ok('cases', r));
    } catch (err) { return this.fail(err); }
  }

  async addComment(id: string, author: string, body: string, key: string, expectedVersion: number | null): Promise<{ comment: Comment; version: number }> {
    const p = z.object({ comment: z.object({ id: z.string(), author: z.string(), body: z.string(), at: z.string() }), version: z.number() })
      .safeParse(await this.write(`/case-system/cases/${id}/comments`, { author, body }, key, expectedVersion));
    if (!p.success) return this.fail(new UpstreamError('cases', 'upstream_error'));
    return p.data;
  }

  async escalate(id: string, author: string, e: { level: string; reason: string; note: string }, key: string, expectedVersion: number): Promise<Case> {
    const c = this.parseCase(await this.write(`/case-system/cases/${id}/escalation`, { author, ...e }, key, expectedVersion));
    return c ?? this.fail(new UpstreamError('cases', 'upstream_error'));
  }
}
