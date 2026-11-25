/** Business logic: the aggregated customer, case search, comments, escalation and human approval. */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { canSee, requirePerson, requireScope, type Principal } from '../auth.ts';
import type { Config } from '../config.ts';
import type { Clock } from '../context.ts';
import { Problem } from '../problem.ts';
import { tx, type Db } from '../store/db.ts';
import { caseKey, compareKeys, type Case, type CaseFilter, type CaseKey, type CaseSort, type Entitlement, type SourceStatus, type Tier, type Upstreams } from '../upstream/adapters.ts';
import type { Webhooks } from '../webhooks/sender.ts';
import { canonical, sha256, type Audit, type Idempotency, type Stored } from './platform.ts';
import { redactText } from './redaction.ts';

type Escalation = { level: 'L2' | 'L3'; reason: string; note: string };
type ActionRow = { id: string; action: 'add_comment' | 'escalate'; case_id: string; customer_id: string; case_version: number; payload: string; status: string; requested_by: string; agent: string; decided_by: string | null; failure: string | null; created_at: string; expires_at: string };
export type CaseQuery = { customerId?: string; priority?: string[]; status?: string[]; supportTier?: Tier[]; escalated?: boolean; openForMoreThanHours?: number; renewalWithinDays?: number; sort: 'openedAt' | '-openedAt' | 'priority' | 'renewalDate'; limit: number; cursor?: string };

const ACTIVE = ['open', 'in_progress', 'waiting_on_customer'];
const SCOPE_OF = { add_comment: 'cases:comment', escalate: 'cases:escalate' } as const;
const APPROVAL_TTL_MS = 30 * 60_000;
const NO_RENEWAL = '9999-12-31';

export const daysBetween = (now: Date, date: string): number =>
  Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`)) / 86_400_000);
export const hoursOpen = (now: Date, c: Pick<Case, 'openedAt' | 'status'>): number | null =>
  ACTIVE.includes(c.status) ? (now.getTime() - Date.parse(c.openedAt)) / 3_600_000 : null;

/** Pure so it can be unit tested. Returns the first broken rule. */
export function brokenRule(c: Case, level: 'L2' | 'L3', tier: Tier, now: Date): { rule: string; detail: string } | null {
  if (!ACTIVE.includes(c.status)) return { rule: 'status', detail: `The case is ${c.status}.` };
  if (c.priority !== 'P1' && c.priority !== 'P2') return { rule: 'priority', detail: `Only P1 and P2 can be escalated; this is ${c.priority}.` };
  const next = c.escalation === null ? 'L2' : c.escalation.level === 'L2' ? 'L3' : null;
  if (next === null) return { rule: 'level', detail: 'The case is already at L3.' };
  if (level !== next) return { rule: 'level', detail: `The next level is ${next}.` };
  if (tier !== 'Platinum' && (hoursOpen(now, c) ?? 0) < 4) return { rule: 'min_age', detail: 'Cases of non-Platinum customers must be open for at least 4 hours.' };
  return null;
}

export class Domain {
  private readonly config: Config;
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly up: Upstreams;
  private readonly audit: Audit;
  private readonly idem: Idempotency;
  private readonly webhooks: Webhooks;

  constructor(d: { config: Config; db: Db; clock: Clock; upstreams: Upstreams; audit: Audit; idempotency: Idempotency; webhooks: Webhooks }) {
    this.config = d.config;
    this.db = d.db;
    this.clock = d.clock;
    this.up = d.upstreams;
    this.audit = d.audit;
    this.idem = d.idempotency;
    this.webhooks = d.webhooks;
  }

  private entitlementDown(s: SourceStatus): never {
    throw new Problem('upstream-unavailable', `Entitlement data is unavailable (${s.reason ?? 'unknown'}).`, { source: 'entitlement' }, { 'Retry-After': '10' });
  }

  // --- Customers -----------------------------------------------------------------------------------------------

  async customer(p: Principal, id: string): Promise<Record<string, unknown>> {
    if (!canSee(p, id)) throw new Problem('not-found'); // same answer as a missing one, so ids cannot be probed
    const [ent, usage] = await Promise.all([this.up.entitlements(), this.up.usage(id)]);
    if (!ent.map) this.entitlementDown(ent.source);
    const e = ent.map.get(id);
    if (!e) throw new Problem('not-found');
    const now = this.clock();
    const showArr = p.scopes.has('customers:arr:read') && !p.agent; // agents never see ARR, whatever the token says
    return {
      id, name: e.name, supportTier: e.tier, contractEndDate: e.contractEnd, renewalDate: e.renewal,
      daysToRenewal: e.renewal ? daysBetween(now, e.renewal) : null,
      ...(showArr && { arrUsd: e.arrUsd }),
      usage: usage.data, degraded: ent.source.status !== 'fresh' || usage.source.status !== 'fresh',
      sources: { entitlement: ent.source, usage: usage.source },
      dataQuality: e.notes, redactedFields: showArr ? [] : ['arrUsd'], asOf: now.toISOString(),
    };
  }

  // --- Cases ---------------------------------------------------------------------------------------------------

  private text(p: Principal, s: string): string { return p.agent ? redactText(s) : s; }

  private summary(p: Principal, c: Case, e: Entitlement | undefined): Record<string, unknown> {
    const now = this.clock();
    const open = hoursOpen(now, c);
    return {
      id: c.id,
      customer: { id: c.customerId, name: e?.name ?? null, supportTier: e?.tier ?? null, renewalDate: e?.renewal ?? null, daysToRenewal: e?.renewal ? daysBetween(now, e.renewal) : null, dataQuality: e?.notes.filter((n) => n.code !== 'alias_mapped') ?? [] },
      subject: this.text(p, c.subject), priority: c.priority, status: c.status, openedAt: c.openedAt,
      openHours: open === null ? null : Math.round(open * 10) / 10,
      escalation: c.escalation, commentCount: c.comments.length, version: c.version,
    };
  }

  private async detail(p: Principal, c: Case): Promise<Record<string, unknown>> {
    const { map } = await this.up.entitlements();
    return {
      ...this.summary(p, c, map?.get(c.customerId)),
      comments: c.comments.slice(-50).map((m) => ({ id: m.id, author: this.text(p, m.author), body: this.text(p, m.body), at: m.at })),
    };
  }

  private async visibleCase(p: Principal, id: string): Promise<Case> {
    const c = await this.up.getCase(id);
    if (!c || !canSee(p, c.customerId)) throw new Problem('not-found');
    return c;
  }

  async getCase(p: Principal, id: string): Promise<{ etag: string; body: Record<string, unknown> }> {
    const c = await this.visibleCase(p, id);
    return { etag: `"v${c.version}"`, body: await this.detail(p, c) };
  }

  private sealCursor(payload: unknown): string {
    const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${data}.${createHmac('sha256', this.config.masterKey).update(data).digest('base64url')}`;
  }

  private openCursor(cursor: string, bound: string): CaseKey {
    const [data = '', mac = ''] = cursor.split('.');
    const want = createHmac('sha256', this.config.masterKey).update(data).digest();
    const given = Buffer.from(mac, 'base64url');
    if (given.length !== want.length || !timingSafeEqual(given, want)) throw new Problem('invalid-cursor');
    const c = JSON.parse(Buffer.from(data, 'base64url').toString()) as { key: string; id: string; bound: string };
    if (c.bound !== bound) throw new Problem('invalid-cursor', 'The cursor belongs to a different query.');
    return c;
  }

  async listCases(p: Principal, q: CaseQuery): Promise<Record<string, unknown>> {
    const now = this.clock();
    const bound = sha256(canonical({ ...q, cursor: undefined, limit: undefined, sub: p.sub }));
    const after = q.cursor === undefined ? null : this.openCursor(q.cursor, bound);

    const needsEntitlement = q.supportTier !== undefined || q.renewalWithinDays !== undefined || q.sort === 'renewalDate';
    const ent = await this.up.entitlements();
    if (!ent.map && needsEntitlement) this.entitlementDown(ent.source);

    // Push as much as possible into the case system: account scope, entitlement-derived accounts, status, priority.
    const scoped = p.accounts === '*' ? null : [...p.accounts];
    let customerIds = q.customerId === undefined ? scoped : scoped === null || scoped.includes(q.customerId) ? [q.customerId] : [];
    if (ent.map && (q.supportTier !== undefined || q.renewalWithinDays !== undefined)) {
      const matching = [...ent.map.values()].filter((e) => {
        if (q.supportTier && !q.supportTier.includes(e.tier)) return false;
        if (q.renewalWithinDays === undefined) return true;
        const d = e.renewal ? daysBetween(now, e.renewal) : null;
        return d !== null && d >= 0 && d <= q.renewalWithinDays;
      }).map((e) => e.id);
      customerIds = customerIds === null ? matching : customerIds.filter((id) => matching.includes(id));
    }
    const status = q.openForMoreThanHours === undefined ? q.status : (q.status ?? ACTIVE).filter((s) => ACTIVE.includes(s));
    const filter: CaseFilter = {
      ...(customerIds && { accountIds: customerIds }), ...(q.priority && { priority: q.priority }), ...(status && { status }),
      ...(q.escalated !== undefined && { escalated: q.escalated }),
      ...(q.openForMoreThanHours !== undefined && { openedBefore: new Date(now.getTime() - q.openForMoreThanHours * 3_600_000).toISOString() }),
    };
    // Filters are applied again here, so a sloppy upstream filter cannot widen the result.
    const matches = (c: Case): boolean => canSee(p, c.customerId)
      && (!customerIds || customerIds.includes(c.customerId))
      && (!q.priority || q.priority.includes(c.priority))
      && (!status || status.includes(c.status))
      && (q.escalated === undefined || (c.escalation !== null) === q.escalated)
      && (q.openForMoreThanHours === undefined || (hoursOpen(now, c) ?? -1) > q.openForMoreThanHours);

    const found: { c: Case; key: string; id: string }[] = [];
    let skipped = 0;
    if (customerIds?.length !== 0 && status?.length !== 0) {
      const source = q.sort === 'renewalDate' ? this.byRenewal(filter, ent.map!, after) : this.inOrder(filter, q.sort, after, q.limit + 1);
      for await (const item of source) {
        if (item === null) { skipped += 1; continue; }
        if (!matches(item.c)) continue;
        found.push(item);
        if (found.length > q.limit) break;
      }
    }
    const page = found.slice(0, q.limit);
    const last = page.at(-1);
    return {
      data: page.map((x) => this.summary(p, x.c, ent.map?.get(x.c.customerId))),
      meta: {
        nextCursor: last && found.length > q.limit ? this.sealCursor({ key: last.key, id: last.id, bound }) : null,
        degraded: ent.source.status !== 'fresh' || skipped > 0, entitlement: ent.source, asOf: now.toISOString(),
      },
    };
  }

  private async* inOrder(filter: CaseFilter, sort: CaseSort, after: CaseKey | null, size: number): AsyncGenerator<{ c: Case; key: string; id: string } | null> {
    for await (const c of this.up.streamCases(filter, sort, after, Math.min(50, size))) yield c && { c, key: caseKey(sort, c), id: c.id };
  }

  /**
   * The case system does not know renewal dates. Customers are taken in renewal order, 100 at a time without splitting
   * a date, and only the cases of one batch are held in memory. Cases of unknown customers come last.
   */
  private async* byRenewal(filter: CaseFilter, map: Map<string, Entitlement>, after: CaseKey | null): AsyncGenerator<{ c: Case; key: string; id: string } | null> {
    const { accountIds, ...rest } = filter;
    const renewalOf = (id: string): string => map.get(id)?.renewal ?? NO_RENEWAL;
    const known = (accountIds ?? [...map.keys()]).filter((id) => map.has(id)).sort((a, b) => (renewalOf(a) < renewalOf(b) ? -1 : renewalOf(a) > renewalOf(b) ? 1 : 0));
    const batches: CaseFilter[] = [];
    for (let i = 0; i < known.length;) {
      let end = Math.min(i + 100, known.length);
      while (end < known.length && renewalOf(known[end]!) === renewalOf(known[end - 1]!)) end += 1;
      batches.push({ ...rest, accountIds: known.slice(i, end) });
      i = end;
    }
    const unknown = accountIds?.filter((id) => !map.has(id));
    const tail: CaseFilter | null = unknown === undefined ? { ...rest, notAccountIds: [...map.keys()] } : unknown.length ? { ...rest, accountIds: unknown } : null;
    if (tail) batches.push(tail);
    for (const batch of batches) {
      if (after && batch !== tail && batch.accountIds!.every((id) => renewalOf(id) < after.key)) continue;
      const items: { c: Case; key: string; id: string }[] = [];
      for await (const c of this.up.streamCases(batch, 'openedAt', null, 50)) {
        if (c === null) { yield null; continue; }
        items.push({ c, key: renewalOf(c.customerId), id: c.id });
        if (items.length > 5000) throw new Problem('validation', 'Too many cases for this sort. Add filters or sort by openedAt.', { errors: [{ location: 'query.sort', message: 'result too large' }] });
      }
      for (const item of items.sort((a, b) => compareKeys('renewalDate', a, b))) if (!after || compareKeys('renewalDate', item, after) > 0) yield item;
    }
  }

  // --- Writes --------------------------------------------------------------------------------------------------

  async addComment(p: Principal, id: string, body: { body: string }, key: string): Promise<Stored & { replayed: boolean }> {
    return this.current(await this.idem.run(p, `comment:${id}`, key, body, async (ctx) => {
      const c = await this.visibleCase(p, id);
      if (p.agent) return this.requestAction(p, 'add_comment', c, body);
      ctx.markDispatched();
      const r = await this.up.addComment(id, p.sub, body.body, ctx.upstreamKey, null);
      return {
        status: 201, headers: { ETag: `"v${r.version}"` }, body: r.comment,
        commit: () => { this.audit.record({ kind: 'action', actor: p.sub, action: 'add_comment', resource: id, outcome: 'executed', detail: { commentId: r.comment.id, bodySha256: sha256(body.body) } }); },
      };
    }));
  }

  /** A replayed 202 shows the action request as it is now: the first answer ("pending") may be wrong by then. */
  private current(r: Stored & { replayed: boolean }): Stored & { replayed: boolean } {
    if (!r.replayed || r.status !== 202) return r;
    const row = this.db.prepare('SELECT * FROM action_requests WHERE id = ?').get((r.body as { id: string }).id) as unknown as ActionRow | undefined;
    return row ? { ...r, body: this.view(row) } : r;
  }

  private async tierFor(c: Case): Promise<Tier> {
    const ent = await this.up.entitlements();
    if (!ent.map) this.entitlementDown(ent.source);
    return ent.map.get(c.customerId)?.tier ?? 'Standard'; // unknown customers get the strictest rule
  }

  private async checkEscalation(c: Case, level: 'L2' | 'L3', version: number): Promise<void> {
    if (c.version !== version) throw new Problem('version-mismatch', `The case is at version ${c.version}, not ${version}. Read it again and retry.`);
    const broken = brokenRule(c, level, await this.tierFor(c), this.clock());
    if (broken) throw new Problem('escalation-rule', broken.detail, { rule: broken.rule });
  }

  private commitEscalation(c: Case, e: Escalation, actor: string, agent: string | null): void {
    this.webhooks.enqueue('case.escalated', { caseId: c.id, customerId: c.customerId, priority: c.priority, level: e.level, reason: e.reason, version: c.version });
    this.audit.record({ kind: 'action', actor, agent, action: 'escalate', resource: c.id, outcome: 'executed', detail: { level: e.level, reason: e.reason, noteSha256: sha256(e.note) } });
  }

  async escalate(p: Principal, id: string, e: Escalation, key: string, ifMatch: string | undefined): Promise<Stored & { replayed: boolean }> {
    if (ifMatch === undefined) throw new Problem('precondition-required', 'Send the ETag from GET /v1/cases/{caseId} as If-Match.');
    const version = Number(/\d+/.exec(ifMatch)![0]);
    return this.current(await this.idem.run(p, `escalate:${id}`, key, { ...e, version }, async (ctx) => {
      const c = await this.visibleCase(p, id);
      if (!ctx.dispatched) await this.checkEscalation(c, e.level, version);
      if (p.agent) return this.requestAction(p, 'escalate', c, e);
      ctx.markDispatched();
      const done = await this.up.escalate(id, p.sub, e, ctx.upstreamKey, version);
      return { status: 200, headers: { ETag: `"v${done.version}"` }, body: await this.detail(p, done), commit: () => this.commitEscalation(done, e, p.sub, null) };
    }));
  }

  // --- Human approval ------------------------------------------------------------------------------------------

  /** Agents never write directly. They leave a request that a person decides with their own token. */
  private requestAction(p: Principal, action: ActionRow['action'], c: Case, payload: unknown): Stored & { commit: () => void } {
    const now = this.clock();
    const row: ActionRow = {
      id: `act_${randomBytes(8).toString('hex')}`, action, case_id: c.id, customer_id: c.customerId, case_version: c.version, payload: JSON.stringify(payload),
      status: 'pending', requested_by: p.sub, agent: p.agent!, decided_by: null, failure: null,
      created_at: now.toISOString(), expires_at: new Date(now.getTime() + APPROVAL_TTL_MS).toISOString(),
    };
    return {
      status: 202, headers: { Location: `/v1/action-requests/${row.id}` }, body: this.view(row),
      commit: () => {
        this.db.prepare('INSERT INTO action_requests VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(row.id, row.action, row.case_id, row.customer_id, row.case_version, row.payload, row.status, row.requested_by, row.agent, null, null, row.created_at, row.expires_at);
        this.audit.record({ kind: 'action', actor: p.sub, agent: p.agent, action, resource: c.id, outcome: 'pending_approval', detail: { actionRequestId: row.id } });
      },
    };
  }

  private view(r: ActionRow): Record<string, unknown> {
    const expired = r.status === 'pending' && Date.parse(r.expires_at) <= this.clock().getTime();
    return {
      id: r.id, action: r.action, caseId: r.case_id, customerId: r.customer_id, caseVersion: r.case_version, payload: JSON.parse(r.payload) as unknown,
      status: expired ? 'expired' : r.status, requestedBy: r.requested_by, agent: r.agent, decidedBy: r.decided_by, failure: r.failure, createdAt: r.created_at, expiresAt: r.expires_at,
    };
  }

  private mayView(p: Principal, r: ActionRow): boolean {
    if (!canSee(p, r.customer_id)) return false;
    if (p.agent) return r.requested_by === p.sub && r.agent === p.agent;
    return r.requested_by === p.sub || p.scopes.has('approvals:manage');
  }

  /** Same rules as mayView, but in SQL, so the limit applies after filtering. */
  listActions(p: Principal, status?: string): Record<string, unknown> {
    const where: string[] = [];
    const args: string[] = [];
    if (p.agent) { where.push('requested_by = ? AND agent = ?'); args.push(p.sub, p.agent); }
    else if (!p.scopes.has('approvals:manage')) { where.push('requested_by = ?'); args.push(p.sub); }
    if (p.accounts !== '*') { where.push('customer_id IN (SELECT value FROM json_each(?))'); args.push(JSON.stringify([...p.accounts])); }
    const now = this.clock().toISOString();
    if (status === 'expired') { where.push("(status = 'expired' OR (status = 'pending' AND expires_at <= ?))"); args.push(now); }
    else if (status === 'pending') { where.push("status = 'pending' AND expires_at > ?"); args.push(now); }
    else if (status) { where.push('status = ?'); args.push(status); }
    const rows = this.db.prepare(`SELECT * FROM action_requests ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, id LIMIT 100`).all(...args) as unknown as ActionRow[];
    return { data: rows.map((r) => this.view(r)) };
  }

  private action(p: Principal, id: string): ActionRow {
    const row = this.db.prepare('SELECT * FROM action_requests WHERE id = ?').get(id) as unknown as ActionRow | undefined;
    if (!row || !this.mayView(p, row)) throw new Problem('not-found');
    return row;
  }

  getAction(p: Principal, id: string): Record<string, unknown> { return this.view(this.action(p, id)); }

  /** Compare-and-set, so two approvers cannot both decide. */
  private transition(id: string, from: string[], to: string, by: string, failure: string | null = null): boolean {
    return this.db.prepare(`UPDATE action_requests SET status = ?, decided_by = ?, failure = ? WHERE id = ? AND status IN (${from.map(() => '?').join(',')})`).run(to, by, failure, id, ...from).changes === 1;
  }

  private decidable(p: Principal, id: string): ActionRow {
    requirePerson(p);
    const r = this.action(p, id);
    requireScope(p, SCOPE_OF[r.action]);
    const shown = this.view(r).status;
    if (shown !== 'pending' && shown !== 'executing') throw new Problem('already-decided', `The request is ${String(shown)}.`);
    return r;
  }

  reject(p: Principal, id: string): Record<string, unknown> {
    const r = this.decidable(p, id);
    tx(this.db, () => {
      if (!this.transition(id, ['pending'], 'rejected', p.sub)) throw new Problem('already-decided', 'The request was already decided.');
      this.audit.record({ kind: 'action', actor: p.sub, agent: r.agent, action: r.action, resource: r.case_id, outcome: 'rejected', detail: { actionRequestId: id, requestedBy: r.requested_by } });
    });
    return this.getAction(p, id);
  }

  async approve(p: Principal, id: string): Promise<Record<string, unknown>> {
    const r = this.decidable(p, id);
    const payload = JSON.parse(r.payload) as Escalation & { body: string };
    const author = `${r.requested_by} (via ${r.agent}, approved by ${p.sub})`;
    // Only end the state this call owns: another approver may already be executing.
    let owned = r.status === 'executing' ? 'executing' : 'pending';
    const end = (to: string, failure: string): void => {
      tx(this.db, () => {
        if (this.transition(id, [owned], to, p.sub, failure)) {
          this.audit.record({ kind: 'action', actor: p.sub, agent: r.agent, action: r.action, resource: r.case_id, outcome: to, detail: { actionRequestId: id } });
        }
      });
    };
    try {
      if (r.status === 'pending') {
        const c = await this.visibleCase(p, r.case_id);
        if (c.version !== r.case_version) throw new Problem('version-mismatch', 'The case changed after the agent proposed this. Ask for a new proposal.');
        if (r.action === 'escalate') await this.checkEscalation(c, payload.level, r.case_version);
        if (!this.transition(id, ['pending'], 'executing', p.sub)) throw new Problem('already-decided', 'The request was already decided.');
        owned = 'executing';
      }
      // The request id is the upstream key. If the outcome is unknown the request stays `executing` and approving it
      // again resends the same write safely.
      const done = r.action === 'escalate'
        ? { kind: 'escalate' as const, c: await this.up.escalate(r.case_id, author, payload, id, r.case_version) }
        : { kind: 'comment' as const, r: await this.up.addComment(r.case_id, author, payload.body, id, r.case_version) };
      tx(this.db, () => {
        if (!this.transition(id, ['executing'], 'executed', p.sub)) return; // a concurrent approve already committed
        if (done.kind === 'escalate') this.commitEscalation(done.c, payload, p.sub, r.agent);
        else this.audit.record({ kind: 'action', actor: p.sub, agent: r.agent, action: r.action, resource: r.case_id, outcome: 'executed', detail: { actionRequestId: id, requestedBy: r.requested_by, commentId: done.r.comment.id } });
      });
    } catch (err) {
      if (err instanceof Problem && err.type === 'version-mismatch') end('stale', err.message);
      else if (err instanceof Problem && err.type === 'escalation-rule') end('failed', err.message);
      throw err;
    }
    return this.getAction(p, id);
  }
}
