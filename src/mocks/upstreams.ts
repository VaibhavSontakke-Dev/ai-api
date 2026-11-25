/**
 * Local stand-ins for the three upstream systems, with fault injection.
 *   /case-system   REST, like Salesforce
 *   /entitlements  CSV export and XML feed, like NetSuite
 *   /warehouse     SQL over HTTP with bind variables, like the Snowflake SQL API
 * Fixtures keep the inconsistent field names and ids of the assignment appendix on purpose.
 */
import express from 'express';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

export type FaultMode = 'off' | 'error' | 'hang' | 'flaky';
export type FaultTarget = 'cases' | 'csv' | 'xml' | 'warehouse';

const fixture = (name: string): string => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

type RawComment = { id?: string; author: string; body: string; at: string };
type RawCase = {
  id: string; accountId: string; priority: string; Status: string; openedAt: string; subject: string;
  Comments: RawComment[]; version: number; escalation?: { level: string; reason: string; at: string };
};

export function createMockUpstreams(opts: { apiKey: string; now: () => Date }) {
  const faults: Record<FaultTarget, FaultMode> = { cases: 'off', csv: 'off', xml: 'off', warehouse: 'off' };
  const hits: Record<FaultTarget, number> = { cases: 0, csv: 0, xml: 0, warehouse: 0 };
  const stats = { records: 0, shuffle: false };
  let cases = new Map<string, RawCase>();
  const writes = new Map<string, unknown>();

  const warehouse = new DatabaseSync(':memory:');
  warehouse.exec('CREATE TABLE usage_monthly (account_id TEXT, month TEXT, protected_tb REAL, api_calls INTEGER, active_users INTEGER, PRIMARY KEY (account_id, month))');
  for (const line of fixture('usage.csv').trim().split('\n').slice(1)) {
    const [id, month, tb, calls, users] = line.trim().split(',');
    warehouse.prepare('INSERT INTO usage_monthly VALUES (?,?,?,?,?)').run(id!, month!, Number(tb), Number(calls), Number(users));
  }

  const reset = (): void => {
    cases = new Map((JSON.parse(fixture('cases.json')) as Omit<RawCase, 'version'>[]).map((c) => [
      c.id, { ...c, version: 1, Comments: c.Comments.map((m, i) => ({ id: `${c.id}-c${i + 1}`, ...m })) },
    ]));
    writes.clear();
    for (const k of Object.keys(faults) as FaultTarget[]) { faults[k] = 'off'; hits[k] = 0; }
    stats.records = 0;
    stats.shuffle = false;
  };
  reset();

  const app = express();
  app.use(express.json());

  app.post('/__faults', (req, res) => {
    const { target, mode } = req.body as { target: FaultTarget; mode: FaultMode };
    if (!(target in faults) || !['off', 'error', 'hang', 'flaky'].includes(mode)) { res.status(400).json({ error: 'bad fault' }); return; }
    faults[target] = mode;
    res.json(faults);
  });
  app.post('/__reset', (_req, res) => { reset(); res.json({ ok: true }); });

  app.use((req, res, next) => {
    if (req.get('x-api-key') !== opts.apiKey) { res.status(401).json({ error: 'bad upstream key' }); return; }
    next();
  });

  const fault = (target: FaultTarget): express.RequestHandler => (_req, res, next) => {
    hits[target] += 1;
    if (faults[target] === 'error') { res.status(503).json({ error: 'injected' }); return; }
    if (faults[target] === 'hang') return; // never answers; the caller's timeout must fire
    if (faults[target] === 'flaky' && hits[target] % 2 === 1) { res.status(502).json({ error: 'injected flake' }); return; }
    next();
  };

  // --- Case system -------------------------------------------------------------------------------------------
  app.post('/case-system/cases/query', fault('cases'), (req, res) => {
    const q = req.body as { accountIds?: string[]; notAccountIds?: string[]; priority?: string[]; status?: string[]; escalated?: boolean; openedBefore?: string; sort: string; after?: { key: string; id: string }; offset: number; limit: number };
    const keyOf = (c: RawCase): string => (q.sort === 'priority' ? c.priority : new Date(c.openedAt).toISOString());
    const compare = (a: { key: string; id: string }, b: { key: string; id: string }): number =>
      (a.key !== b.key ? (a.key < b.key ? -1 : 1) * (q.sort === '-openedAt' ? -1 : 1) : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const all = [...cases.values()].filter((c) =>
      (!q.accountIds || q.accountIds.includes(c.accountId)) && !q.notAccountIds?.includes(c.accountId)
      && (!q.priority || q.priority.includes(c.priority)) && (!q.status || q.status.includes(c.Status))
      && (q.escalated === undefined || !!c.escalation === q.escalated)
      && (!q.openedBefore || Date.parse(c.openedAt) < Date.parse(q.openedBefore)))
      .map((c) => ({ c, key: keyOf(c), id: c.id })).sort(compare).filter((x) => !q.after || compare(x, q.after) > 0);
    const records = all.slice(q.offset, q.offset + q.limit).map((x) => x.c);
    stats.records += records.length;
    res.json({ records: stats.shuffle ? records.reverse() : records, done: q.offset + q.limit >= all.length });
  });
  app.get('/case-system/cases/:id', fault('cases'), (req, res) => {
    const c = cases.get(String(req.params.id));
    if (!c) { res.status(404).json({ error: 'not found' }); return; }
    res.json(c);
  });
  /** Writes are deduplicated on the idempotency key and checked against the expected version. */
  const write = (apply: (c: RawCase, body: Record<string, string>) => unknown): express.RequestHandler => (req, res) => {
    const key = req.get('idempotency-key');
    if (key && writes.has(key)) { res.json(writes.get(key)); return; }
    const c = cases.get(String(req.params.id));
    if (!c) { res.status(404).json({ error: 'not found' }); return; }
    const expected = req.get('x-expected-version');
    if (expected && Number(expected) !== c.version) { res.status(409).json({ error: 'version', version: c.version }); return; }
    const out = structuredClone(apply(c, req.body as Record<string, string>));
    if (key) writes.set(key, out);
    res.json(out);
  };
  app.post('/case-system/cases/:id/comments', fault('cases'), write((c, b) => {
    const comment = { id: randomUUID(), author: b.author!, body: b.body!, at: opts.now().toISOString() };
    c.Comments.push(comment);
    c.version += 1;
    return { comment, version: c.version };
  }));
  app.post('/case-system/cases/:id/escalation', fault('cases'), write((c, b) => {
    c.escalation = { level: b.level!, reason: b.reason!, at: opts.now().toISOString() };
    c.Comments.push({ id: randomUUID(), author: b.author!, body: `Escalated to ${b.level}: ${b.note}`, at: opts.now().toISOString() });
    c.version += 1;
    return c;
  }));

  // --- Entitlement system ------------------------------------------------------------------------------------
  app.get('/entitlements/export.csv', fault('csv'), (_req, res) => { res.type('text/csv').send(fixture('entitlements.csv')); });
  app.get('/entitlements/feed.xml', fault('xml'), (_req, res) => { res.type('application/xml').send(fixture('entitlements.xml')); });

  // --- Usage warehouse ---------------------------------------------------------------------------------------
  app.post('/warehouse/statements', fault('warehouse'), (req, res) => {
    const { statement, bindings } = req.body as { statement: string; bindings: string[] };
    if (!/^\s*SELECT\b/i.test(statement) || statement.includes(';')) { res.status(400).json({ error: 'read only' }); return; }
    res.json({ data: warehouse.prepare(statement).all(...bindings) });
  });

  /** Bulk data for paging tests. */
  const addCases = (n: number, accountId?: string): void => {
    const accounts = ['ACC-007', 'ACC-012', 'ACC-019', 'ACC-031', 'ACC-060', 'ACC-077'];
    for (let i = 0; i < n; i++) {
      const id = `CS-${500_000 + i}`;
      cases.set(id, { id, accountId: accountId ?? accounts[i % accounts.length]!, priority: `P${(i % 4) + 1}`, Status: 'open', openedAt: new Date(Date.parse('2026-11-01T00:00:00Z') + (i % 97) * 60_000).toISOString(), subject: `Bulk ${i}`, Comments: [], version: 1 });
    }
  };

  return { app, faults, hits, stats, addCases, reset };
}
