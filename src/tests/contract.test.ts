/**
 * Contract and behaviour tests against a running stack. `s.call` validates every response (status, media type, body)
 * against openapi.yaml, so each test below is also a contract test. The last test fails if an operation was never called.
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { startStack, type Stack, type Reply } from './harness.ts';
import { createReceiver } from '../webhooks/receiver.ts';
import { API_AUDIENCE } from '../mocks/idp.ts';

let s: Stack;
const t: Record<string, string> = {};
const covered = new Set<string>();
let n = 0;
const key = (): string => `test-key-${++n}`;

before(async () => {
  s = await startStack();
  for (const u of ['sam.support', 'lena.lead', 'fiona.finance', 'carl.csm']) t[u.split('.')[0]!] = await s.user(u);
  t.agent = await s.agentToken('sam.support');
  t.agentFiona = await s.agentToken('fiona.finance');
  t.agentCarl = await s.agentToken('carl.csm');
  const original = s.call;
  s.call = async (m, p, o) => {
    const op = s.api.spec.match(m, p.split('?')[0]!);
    if (op) covered.add(op.op.id);
    return original(m, p, o);
  };
});
after(() => s.stop());
afterEach(async () => {
  s.mocks.reset();
  s.setNow(new Date('2026-11-24T12:00:00Z'));
  await sleep(0);
});

const get = (path: string, token = t.sam!, headers?: Record<string, string>): Promise<Reply> => s.call('GET', path, { token, ...(headers && { headers }) });
const problem = (r: Reply, status: number, type: string): void => {
  assert.equal(r.status, status, JSON.stringify(r.body));
  assert.equal(r.body.type, `https://errors.example.com/${type}`);
  assert.equal(r.body.correlationId, r.headers.get('x-correlation-id'));
};
const ids = (r: Reply): string[] => (r.body.data as { id: string }[]).map((c) => c.id);

describe('authentication', () => {
  it('refuses a missing, malformed, expired, wrong-audience and unsigned token', async () => {
    problem(await s.call('GET', '/v1/cases'), 401, 'unauthorized');
    problem(await get('/v1/cases', 'nonsense'), 401, 'unauthorized');
    problem(await get('/v1/cases', await s.idp.userToken('sam.support', API_AUDIENCE, -10)), 401, 'unauthorized');
    problem(await get('/v1/cases', await s.idp.userToken('sam.support', 'support-copilot')), 401, 'unauthorized');
    const [, payload] = t.sam!.split('.');
    problem(await get('/v1/cases', `${Buffer.from('{"alg":"none","typ":"at+jwt"}').toString('base64url')}.${payload}.`), 401, 'unauthorized');
    assert.match((await s.call('GET', '/v1/cases')).headers.get('www-authenticate')!, /Bearer/);
  });
  it('leaves health checks open', async () => {
    assert.equal((await s.call('GET', '/healthz')).status, 200);
    assert.equal((await s.call('GET', '/readyz')).status, 200);
  });
});

describe('GET /v1/customers/{id}', () => {
  it('aggregates entitlement and the latest usage month', async () => {
    const r = await get('/v1/customers/ACC-007');
    assert.equal(r.status, 200);
    assert.equal(r.body.name, 'Acme Corp');
    assert.equal(r.body.daysToRenewal, 52);
    assert.equal(r.body.usage.month, '2026-09');
    assert.equal(r.body.degraded, false);
    assert.ok(r.headers.get('ratelimit-remaining'));
    assert.equal(r.headers.get('cache-control'), 'no-store');
  });
  it('shows ARR to Finance only, and never through an agent', async () => {
    assert.equal((await get('/v1/customers/ACC-007', t.fiona)).body.arrUsd, 480000);
    for (const token of [t.sam!, t.lena!, t.agent!, t.agentFiona!]) {
      const r = await get('/v1/customers/ACC-007', token);
      assert.equal('arrUsd' in r.body, false);
      assert.deepEqual(r.body.redactedFields, ['arrUsd']);
      assert.doesNotMatch(JSON.stringify(r.body), /480000/);
    }
  });
  it('maps ACC-77 to ACC-007 by crosswalk and never mixes it up with ACC-077', async () => {
    const acme = await get('/v1/customers/ACC-007', t.fiona);
    const zenith = await get('/v1/customers/ACC-077', t.fiona);
    assert.deepEqual([acme.body.name, acme.body.arrUsd], ['Acme Corp', 480000]);
    assert.deepEqual([zenith.body.name, zenith.body.arrUsd], ['Zenith Labs', 75000]);
    assert.equal(acme.body.dataQuality[0].code, 'alias_mapped');
    problem(await get('/v1/customers/ACC-77'), 400, 'validation');
  });
  it('quarantines an unmapped export row and audits it', async () => {
    await get('/v1/customers/ACC-007');
    const r = await get('/v1/audit-events?kind=data_quality', t.lena);
    assert.ok(r.body.data.some((e: any) => e.resource === 'ACC-9' && e.outcome === 'quarantined'));
  });
  it('reports a feed conflict instead of hiding it', async () => {
    const r = await get('/v1/customers/ACC-031');
    assert.equal(r.body.renewalDate, '2027-01-31');
    assert.equal(r.body.contractEndDate, '2027-03-20');
    assert.equal(r.body.dataQuality[0].code, 'renewal_conflict');
  });
  it('answers 404 the same way for unknown and out-of-account customers', async () => {
    const unknown = await get('/v1/customers/ACC-999', t.carl);
    const hidden = await get('/v1/customers/ACC-019', t.carl);
    problem(unknown, 404, 'not-found');
    problem(hidden, 404, 'not-found');
    assert.equal(unknown.body.detail, hidden.body.detail);
    assert.equal((await get('/v1/customers/ACC-007', t.carl)).status, 200);
  });
});

describe('resilience', () => {
  /** A stack of its own: these tests open circuits and need cold snapshots. */
  const isolated = async (fn: (x: Stack, sam: string) => Promise<void>, o: Parameters<typeof startStack>[0] = {}): Promise<void> => {
    const x = await startStack(o);
    try { await fn(x, await x.user('sam.support')); } finally { x.stop(); }
  };

  it('usage down with no snapshot: 200, degraded, usage null', () => isolated(async (x, sam) => {
    x.fault('warehouse', 'error');
    const r = await x.call('GET', '/v1/customers/ACC-007', { token: sam });
    assert.equal(r.status, 200);
    assert.equal(r.body.degraded, true);
    assert.equal(r.body.usage, null);
    assert.deepEqual(r.body.sources.usage, { status: 'unavailable', asOf: null, reason: 'upstream_error' });
    assert.equal(r.body.name, 'Acme Corp');
  }));
  it('usage hanging: times out within its budget', () => isolated(async (x, sam) => {
    x.fault('warehouse', 'hang');
    const started = Date.now();
    const r = await x.call('GET', '/v1/customers/ACC-007', { token: sam });
    assert.equal(r.body.sources.usage.reason, 'timeout');
    assert.ok(Date.now() - started < 2000);
  }));
  it('usage down with a snapshot: stale data, labelled', () => isolated(async (x, sam) => {
    await x.call('GET', '/v1/customers/ACC-007', { token: sam });
    x.fault('warehouse', 'error');
    const r = await x.call('GET', '/v1/customers/ACC-007', { token: sam });
    assert.equal(r.body.sources.usage.status, 'stale');
    assert.equal(r.body.usage.protectedTb, 412.5);
  }));
  it('recovers from a flaky upstream by retrying', () => isolated(async (x, sam) => {
    x.fault('warehouse', 'flaky');
    const r = await x.call('GET', '/v1/customers/ACC-007', { token: sam });
    assert.equal(r.body.degraded, false);
    assert.equal(x.mocks.hits.warehouse, 2);
  }));
  it('opens the circuit, stops calling, and recovers', () => isolated(async (x, sam) => {
    x.fault('warehouse', 'error');
    for (let i = 0; i < 3; i++) await x.call('GET', '/v1/customers/ACC-007', { token: sam });
    const before = x.mocks.hits.warehouse;
    const r = await x.call('GET', '/v1/customers/ACC-007', { token: sam });
    assert.equal(r.body.sources.usage.reason, 'circuit_open');
    assert.equal(x.mocks.hits.warehouse, before);
    assert.equal((await x.call('GET', '/readyz')).body.upstreams.warehouse, 'open');
    x.fault('warehouse', 'off');
    await sleep(220);
    assert.equal((await x.call('GET', '/v1/customers/ACC-007', { token: sam })).body.degraded, false);
  }));
  it('entitlement down with no snapshot: 503 for the customer and for entitlement filters, degraded for a plain list', () => isolated(async (x, sam) => {
    x.fault('csv', 'error');
    const c = await x.call('GET', '/v1/customers/ACC-007', { token: sam });
    problem(c, 503, 'upstream-unavailable');
    assert.equal(c.body.source, 'entitlement');
    assert.ok(c.headers.get('retry-after'));
    problem(await x.call('GET', '/v1/cases?supportTier=Platinum', { token: sam }), 503, 'upstream-unavailable');
    const plain = await x.call('GET', '/v1/cases?priority=P1', { token: sam });
    assert.equal(plain.body.meta.degraded, true);
    assert.equal(plain.body.data[0].customer.supportTier, null);
  }));
  it('XML feed down: falls back to the contract export and says so', () => isolated(async (x, sam) => {
    x.fault('xml', 'error');
    const r = await x.call('GET', '/v1/customers/ACC-031', { token: sam });
    assert.equal(r.body.degraded, true);
    assert.equal(r.body.renewalDate, '2027-03-20');
    assert.equal(r.body.dataQuality[0].code, 'missing_in_feed');
  }));
  it('snapshot older than the limit is not used', () => isolated(async (x, sam) => {
    await x.call('GET', '/v1/customers/ACC-007', { token: sam });
    x.fault('csv', 'error');
    await sleep(5);
    problem(await x.call('GET', '/v1/customers/ACC-007', { token: sam }), 503, 'upstream-unavailable');
  }, { staleMs: 1 }));
  it('case system down: 503', () => isolated(async (x, sam) => {
    x.fault('cases', 'error');
    problem(await x.call('GET', '/v1/cases', { token: sam }), 503, 'upstream-unavailable');
  }));
});

describe('GET /v1/cases', () => {
  it('answers the sample question', async () => {
    const r = await get('/v1/cases?supportTier=Platinum&priority=P1&openForMoreThanHours=48&renewalWithinDays=90&sort=renewalDate');
    assert.deepEqual(ids(r), ['CS-10231', 'CS-10260', 'CS-10240', 'CS-10275']);
    assert.equal(r.body.meta.nextCursor, null);
  });
  it('treats "more than" as strict and the renewal window as inclusive', async () => {
    const at = async (iso: string): Promise<string[]> => { s.setNow(new Date(iso)); return ids(await get('/v1/cases?customerId=ACC-060&openForMoreThanHours=48&renewalWithinDays=90')); };
    assert.deepEqual(await at('2026-11-24T00:00:00.000Z'), [], 'exactly 48 h does not match');
    assert.deepEqual(await at('2026-11-24T00:00:00.001Z'), ['CS-10275']);
    assert.deepEqual(await at('2026-11-23T23:59:59Z'), [], '91 days and under 48 h');
  });
  it('never matches finished cases or lapsed renewals', async () => {
    const r = await get('/v1/cases?openForMoreThanHours=0&renewalWithinDays=730&limit=100');
    assert.equal(ids(r).includes('CS-10290'), false);
    assert.equal(ids(r).includes('CS-10285'), false);
    assert.deepEqual(ids(await get('/v1/cases?openForMoreThanHours=1&status=closed')), []);
  });
  it('combines values with OR and filters with AND', async () => {
    const r = await get('/v1/cases?priority=P2,P3&customerId=ACC-007');
    assert.deepEqual(ids(r), ['CS-10291']);
    assert.deepEqual(ids(await get('/v1/cases?escalated=true')), ['CS-10250']);
  });
  for (const sort of ['openedAt', '-openedAt', 'priority', 'renewalDate']) {
    it(`pages through everything once, in order (${sort})`, async () => {
      const all = ids(await get(`/v1/cases?limit=100&sort=${sort}`));
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const r: Reply = await get(`/v1/cases?limit=4&sort=${sort}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
        seen.push(...ids(r));
        cursor = r.body.meta.nextCursor;
      } while (cursor);
      assert.deepEqual(seen, all);
      assert.equal(new Set(seen).size, 17);
    });
  }
  it('refuses a forged cursor, or one from another query or user', async () => {
    const c = (await get('/v1/cases?limit=2')).body.meta.nextCursor as string;
    problem(await get(`/v1/cases?limit=2&cursor=${c.slice(0, -3)}AAA`), 400, 'invalid-cursor');
    problem(await get('/v1/cases?limit=2&cursor=%7B%7D'), 400, 'invalid-cursor');
    problem(await get(`/v1/cases?limit=2&priority=P1&cursor=${c}`), 400, 'invalid-cursor');
    problem(await get(`/v1/cases?limit=2&cursor=${c}`, t.lena), 400, 'invalid-cursor');
  });
  it('refuses unknown, repeated and out-of-range parameters with locations', async () => {
    const r = await get('/v1/cases?priorty=P1&limit=0&status=bogus&priority=P1&priority=P2');
    problem(r, 400, 'validation');
    assert.deepEqual(r.body.errors.map((e: any) => e.location).sort(), ['query.limit', 'query.priority', 'query.priorty', 'query.status/0']);
  });
  it('limits a CSM to their accounts', async () => {
    const r = await get('/v1/cases?limit=100', t.carl);
    assert.deepEqual([...new Set(r.body.data.map((c: any) => c.customer.id))].sort(), ['ACC-007', 'ACC-012']);
    assert.deepEqual(ids(await get('/v1/cases?customerId=ACC-019', t.carl)), []);
  });
  it('normalises the mixed field names of the source', async () => {
    const r = await get('/v1/cases/CS-10231');
    assert.equal(r.body.status, 'open');
    assert.equal(r.body.comments[0].body, 'Investigating');
  });
});

describe('GET /v1/cases/{id}', () => {
  it('supports conditional reads', async () => {
    const r = await get('/v1/cases/CS-10231');
    assert.equal(r.headers.get('etag'), '"v1"');
    assert.equal((await get('/v1/cases/CS-10231', t.sam, { 'if-none-match': '"v1"' })).status, 304);
  });
  it('hides other accounts', async () => { problem(await get('/v1/cases/CS-10250', t.carl), 404, 'not-found'); });
  it('redacts contact data for agents only', async () => {
    assert.match((await get('/v1/cases/CS-10240')).body.comments[0].body, /dana\.ortiz@globex\.example/);
    assert.equal((await get('/v1/cases/CS-10240', t.agent)).body.comments[0].body, 'Customer contact is [email], [phone]. Waiting for logs.');
  });
});

describe('POST /v1/cases/{id}/comments', () => {
  const post = (k: string, body: unknown = { body: 'Hello' }, token = t.sam!, id = 'CS-10231'): Promise<Reply> =>
    s.call('POST', `/v1/cases/${id}/comments`, { token, body, headers: { 'idempotency-key': k } });

  it('creates once and replays', async () => {
    const k = key();
    const a = await post(k);
    const b = await post(k);
    assert.equal(a.status, 201);
    assert.equal(a.headers.get('idempotent-replayed'), null);
    assert.equal(b.headers.get('idempotent-replayed'), 'true');
    assert.deepEqual(a.body, b.body);
    assert.equal((await get('/v1/cases/CS-10231')).body.commentCount, 2);
  });
  it('refuses the same key with another body', async () => {
    const k = key();
    await post(k);
    problem(await post(k, { body: 'Different' }), 422, 'idempotency-mismatch');
  });
  it('creates one comment for concurrent duplicates', async () => {
    const k = key();
    const rs = await Promise.all([post(k), post(k), post(k)]);
    assert.ok(rs.every((r) => r.status === 201 || r.status === 409));
    assert.equal((await get('/v1/cases/CS-10231')).body.commentCount, 2);
  });
  it('a failed attempt can be retried with the same key', async () => {
    const x = await startStack();
    try {
      const token = await x.user('sam.support');
      const send = (): Promise<Reply> => x.call('POST', '/v1/cases/CS-10231/comments', { token, body: { body: 'Hi' }, headers: { 'idempotency-key': 'retry-me-1' } });
      x.fault('cases', 'error');
      problem(await send(), 503, 'upstream-unavailable');
      x.fault('cases', 'off');
      assert.equal((await send()).status, 201);
    } finally { x.stop(); }
  });
  it('validates key, body, media type, JSON and size', async () => {
    problem(await s.call('POST', '/v1/cases/CS-10231/comments', { token: t.sam!, body: { body: 'x' } }), 400, 'validation');
    problem(await post('short'), 400, 'validation');
    problem(await post(key(), { body: '   ' }), 400, 'validation');
    problem(await post(key(), { body: 'x', author: 'ceo' }), 400, 'validation');
    problem(await post(key(), '{bad'), 400, 'validation');
    problem(await s.call('POST', '/v1/cases/CS-10231/comments', { token: t.sam!, headers: { 'idempotency-key': key(), 'content-type': 'text/plain' } }), 400, 'validation');
    problem(await post(key(), { body: 'x'.repeat(40_000) }), 413, 'payload-too-large');
  });
  it('needs the scope and account access', async () => {
    const r = await post(key(), { body: 'x' }, t.fiona);
    problem(r, 403, 'forbidden');
    assert.equal(r.body.requiredScope, 'cases:comment');
    problem(await post(key(), { body: 'x' }, t.carl, 'CS-10250'), 404, 'not-found');
  });
});

describe('POST /v1/cases/{id}/escalate', () => {
  const body = { level: 'L2', reason: 'customer_impact', note: 'Backups failing for a month' };
  const esc = (o: { id?: string; token?: string; match?: string | null; k?: string; body?: object } = {}): Promise<Reply> =>
    s.call('POST', `/v1/cases/${o.id ?? 'CS-10231'}/escalate`, { token: o.token ?? t.sam!, body: o.body ?? body, headers: { 'idempotency-key': o.k ?? key(), ...(o.match !== null && { 'if-match': o.match ?? '"v1"' }) } });

  it('escalates and bumps the version', async () => {
    const r = await esc();
    assert.equal(r.status, 200);
    assert.equal(r.body.escalation.level, 'L2');
    assert.equal(r.headers.get('etag'), '"v2"');
  });
  it('replays instead of escalating twice', async () => {
    const k = key();
    await esc({ k });
    const r = await esc({ k });
    assert.equal(r.headers.get('idempotent-replayed'), 'true');
    assert.equal((await get('/v1/cases/CS-10231')).body.version, 2);
  });
  it('needs a current If-Match', async () => {
    problem(await esc({ match: null }), 428, 'precondition-required');
    problem(await esc({ match: '"v9"' }), 412, 'version-mismatch');
    problem(await esc({ match: '*' }), 400, 'validation');
  });
  it('names the broken rule', async () => {
    for (const [id, over, rule] of [['CS-10290', {}, 'status'], ['CS-10291', {}, 'priority'], ['CS-10231', { level: 'L3' }, 'level'], ['CS-10295', {}, 'min_age']] as const) {
      const r = await esc({ id, body: { ...body, ...over } });
      problem(r, 409, 'escalation-rule');
      assert.equal(r.body.rule, rule);
    }
  });
  it('a refused attempt does not let a retry with the same key skip the rules', async () => {
    const k = key();
    problem(await esc({ id: 'CS-10291', k }), 409, 'escalation-rule');
    problem(await esc({ id: 'CS-10291', k }), 409, 'escalation-rule');
  });
  it('after a lost answer, the retry does not escalate twice and emits one event', async () => {
    const x = await startStack({ webhookAllowedHosts: ['hook.test'] });
    try {
      const token = await x.user('sam.support');
      await x.api.webhooks.subscribe('http://hook.test/', ['case.escalated'], 'test');
      const send = (): Promise<Reply> => x.call('POST', '/v1/cases/CS-10231/escalate', { token, body, headers: { 'idempotency-key': 'lost-answer-1', 'if-match': '"v1"' } });
      // The upstream applies the write, then the answer is lost.
      const real = x.api.upstreams.caseClient.request.bind(x.api.upstreams.caseClient);
      x.api.upstreams.caseClient.request = async (path, init) => {
        const r = await real(path, init);
        if (path.endsWith('/escalation')) return { status: 500, text: '' };
        return r;
      };
      problem(await send(), 503, 'upstream-unavailable');
      x.api.upstreams.caseClient.request = real;
      const r = await send();
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.version, 2);
      assert.equal((x.api.db.prepare('SELECT count(*) n FROM webhook_deliveries').get() as { n: number }).n, 1);
    } finally { x.stop(); }
  });
});

describe('webhooks', () => {
  it('delivers a signed event once per escalation, with no free text, and retries until accepted', async () => {
    let secret = '';
    let up = false;
    const events: any[] = [];
    const receiver = createReceiver(() => (up ? secret : null), (e) => events.push(e));
    const { url, server } = await s.listen(receiver);
    s.config.webhookAllowedHosts.push(new URL(url).host);
    const sub = await s.call('POST', '/v1/webhook-subscriptions', { token: t.lena!, body: { url: `${url}/hooks`, events: ['case.escalated'] } });
    assert.equal(sub.status, 201);
    secret = sub.body.secret;
    assert.doesNotMatch(JSON.stringify((await get('/v1/webhook-subscriptions', t.lena)).body), /whsec_/);
    const note = 'Confidential note about the customer';
    await s.call('POST', '/v1/cases/CS-10231/escalate', { token: t.sam!, body: { level: 'L2', reason: 'customer_impact', note }, headers: { 'idempotency-key': key(), 'if-match': '"v1"' } });
    await s.api.webhooks.deliverDue(); // receiver refuses
    assert.equal(events.length, 0);
    up = true;
    await sleep(5);
    await s.api.webhooks.deliverDue();
    await s.api.webhooks.deliverDue();
    assert.equal(events.length, 1);
    const valid = s.api.spec.schema('CaseEscalatedEvent');
    assert.ok(valid(events[0]), JSON.stringify(valid.errors));
    assert.doesNotMatch(JSON.stringify(events[0]), /Confidential/);
    assert.notEqual((await s.call('POST', `/v1/webhook-subscriptions/${sub.body.id}/rotate-secret`, { token: t.lena! })).body.secret, secret);
    assert.equal((await s.call('DELETE', `/v1/webhook-subscriptions/${sub.body.id}`, { token: t.lena! })).status, 204);
    problem(await s.call('DELETE', `/v1/webhook-subscriptions/${sub.body.id}`, { token: t.lena! }), 404, 'not-found');
    (server as any).closeAllConnections();
    server.close();
  });
  it('gives up after the attempt limit and audits it', async () => {
    const x = await startStack({ webhookAllowedHosts: ['127.0.0.1:9'] });
    try {
      await x.api.webhooks.subscribe('http://127.0.0.1:9/', ['case.escalated'], 'test');
      x.api.webhooks.enqueue('case.escalated', {});
      for (let i = 0; i < 4; i++) { await x.api.webhooks.deliverDue(); await sleep(3); }
      const d = x.api.db.prepare('SELECT status, attempts FROM webhook_deliveries').get() as { status: string; attempts: number };
      assert.deepEqual({ ...d }, { status: 'dead', attempts: 3 });
    } finally { x.stop(); }
  });
  it('refuses internal targets and callers without the scope', async () => {
    const create = (url: string, token: string): Promise<Reply> => s.call('POST', '/v1/webhook-subscriptions', { token, body: { url, events: ['case.escalated'] } });
    problem(await create('https://169.254.169.254/latest/meta-data', t.lena!), 422, 'target-not-allowed');
    problem(await create('http://example.com/', t.lena!), 422, 'target-not-allowed');
    problem(await create('https://8.8.8.8/', t.sam!), 403, 'forbidden');
  });
});

describe('agents and human approval', () => {
  const propose = async (token = t.agent!, id = 'CS-10231'): Promise<Reply> =>
    s.call('POST', `/v1/cases/${id}/escalate`, { token, body: { level: 'L2', reason: 'customer_impact', note: 'Proposed by the copilot' }, headers: { 'idempotency-key': key(), 'if-match': '"v1"' } });
  const decide = (id: string, what: 'approve' | 'reject', token: string): Promise<Reply> => s.call('POST', `/v1/action-requests/${id}/${what}`, { token });

  it('an agent write changes nothing until a person approves', async () => {
    const r = await propose();
    assert.equal(r.status, 202);
    assert.equal(r.headers.get('location'), `/v1/action-requests/${r.body.id}`);
    assert.equal((await get('/v1/cases/CS-10231')).body.escalation, null);
    const done = await decide(r.body.id, 'approve', t.sam!);
    assert.equal(done.body.status, 'executed');
    const c = await get('/v1/cases/CS-10231');
    assert.equal(c.body.escalation.level, 'L2');
    assert.match(c.body.comments.at(-1).author, /sam\.support \(via agent:support-copilot-mcp, approved by sam\.support\)/);
  });
  it('agent comments wait for approval too', async () => {
    const r = await s.call('POST', '/v1/cases/CS-10231/comments', { token: t.agent!, body: { body: 'Draft' }, headers: { 'idempotency-key': key() } });
    assert.equal(r.status, 202);
    assert.equal((await get('/v1/cases/CS-10231')).body.commentCount, 1);
    assert.equal((await decide(r.body.id, 'approve', t.lena!)).body.status, 'executed');
    assert.equal((await get('/v1/cases/CS-10231')).body.commentCount, 2);
  });
  it('an agent can never approve or reject, not even its own request', async () => {
    const r = await propose();
    problem(await decide(r.body.id, 'approve', t.agent!), 403, 'agent-not-allowed');
    problem(await decide(r.body.id, 'reject', t.agent!), 403, 'agent-not-allowed');
    assert.equal((await get(`/v1/action-requests/${r.body.id}`, t.agent)).body.status, 'pending');
  });
  it('another user cannot see or approve it, and the approver needs the action scope', async () => {
    const r = await propose();
    problem(await decide(r.body.id, 'approve', t.carl!), 404, 'not-found');
    const own = await s.call('POST', '/v1/cases/CS-10240/comments', { token: t.agentCarl!, body: { body: 'x' }, headers: { 'idempotency-key': key() } });
    problem(await decide(own.body.id, 'approve', t.sam!), 404, 'not-found');
    assert.equal((await decide(own.body.id, 'approve', t.carl!)).status, 200);
  });
  it('decides once', async () => {
    const a = await propose();
    await decide(a.body.id, 'reject', t.sam!);
    problem(await decide(a.body.id, 'approve', t.sam!), 409, 'already-decided');
    const b = await propose();
    const both = await Promise.all([decide(b.body.id, 'approve', t.sam!), decide(b.body.id, 'approve', t.lena!)]);
    assert.ok(both.some((r) => r.status === 200));
    assert.equal((await get('/v1/cases/CS-10231')).body.version, 2, 'applied exactly once');
  });
  it('goes stale when the case changed, and expires', async () => {
    const a = await propose();
    await s.call('POST', '/v1/cases/CS-10231/comments', { token: t.sam!, body: { body: 'News' }, headers: { 'idempotency-key': key() } });
    problem(await decide(a.body.id, 'approve', t.sam!), 412, 'version-mismatch');
    assert.equal((await get(`/v1/action-requests/${a.body.id}`)).body.status, 'stale');
    const b = await s.call('POST', '/v1/cases/CS-10231/comments', { token: t.agent!, body: { body: 'Late' }, headers: { 'idempotency-key': key() } });
    s.setNow(new Date('2026-11-24T12:31:00Z'));
    problem(await decide(b.body.id, 'approve', t.sam!), 409, 'already-decided');
    assert.ok(ids(await get('/v1/action-requests?status=expired')).includes(b.body.id));
  });
  it('can be approved again after an upstream outage, and runs once', async () => {
    const x = await startStack();
    try {
      const sam = await x.user('sam.support');
      const r = await x.call('POST', '/v1/cases/CS-10231/comments', { token: await x.agentToken('sam.support'), body: { body: 'Hi' }, headers: { 'idempotency-key': 'outage-001' } });
      const real = x.api.upstreams.caseClient.request.bind(x.api.upstreams.caseClient);
      x.api.upstreams.caseClient.request = async (path, init) => { const out = await real(path, init); return init?.method === 'POST' ? { status: 500, text: '' } : out; };
      problem(await x.call('POST', `/v1/action-requests/${r.body.id}/approve`, { token: sam }), 503, 'upstream-unavailable');
      x.api.upstreams.caseClient.request = real;
      assert.equal((await x.call('POST', `/v1/action-requests/${r.body.id}/approve`, { token: sam })).body.status, 'executed');
      assert.equal((await x.call('GET', '/v1/cases/CS-10231', { token: sam })).body.commentCount, 2);
    } finally { x.stop(); }
  });
  it('a second approver arriving between the upstream write and the commit cannot mark it stale', async () => {
    const x = await startStack();
    try {
      const sam = await x.user('sam.support');
      const lena = await x.user('lena.lead');
      const r = await x.call('POST', '/v1/cases/CS-10231/escalate', { token: await x.agentToken('sam.support'), body: { level: 'L2', reason: 'customer_impact', note: 'Proposed by copilot' }, headers: { 'idempotency-key': 'race-0001', 'if-match': '"v1"' } });
      const real = x.api.upstreams.caseClient.request.bind(x.api.upstreams.caseClient);
      const realGet = x.api.upstreams.getCase.bind(x.api.upstreams);
      // Lena passes the `pending` check, then is held until Sam's write has been applied upstream.
      let applied!: () => void;
      const onApplied = new Promise<void>((res) => { applied = res; });
      let lenaDone!: () => void;
      const onLenaDone = new Promise<void>((res) => { lenaDone = res; });
      let gets = 0;
      x.api.upstreams.getCase = async (id) => { if (++gets === 1) await onApplied; return realGet(id); };
      x.api.upstreams.caseClient.request = async (path, init) => { const out = await real(path, init); if (init?.method === 'POST') { applied(); await onLenaDone; } return out; };
      const second = x.call('POST', `/v1/action-requests/${r.body.id}/approve`, { token: lena }).finally(() => lenaDone());
      while (gets === 0) await sleep(1);
      const first = await x.call('POST', `/v1/action-requests/${r.body.id}/approve`, { token: sam });
      await second;
      assert.equal(first.status, 200);
      assert.equal(first.body.status, 'executed');
    } finally { x.stop(); }
  });
  it('the proposal itself must satisfy the rules and the user rights', async () => {
    problem(await propose(t.agent, 'CS-10291'), 409, 'escalation-rule');
    problem(await propose(t.agentCarl), 403, 'forbidden');
  });
  it('token exchange narrows scopes, refuses chains and bad clients', async () => {
    await assert.rejects(s.agentToken('fiona.finance', 'customers:arr:read'), /invalid_scope/);
    await assert.rejects(s.agentToken('lena.lead', 'approvals:manage'), /invalid_scope/);
    const exchange = async (over: object): Promise<string> => {
      const res = await fetch(`${s.idpUrl}/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange', client_id: 'support-copilot-mcp', client_secret: 'test-agent-secret', audience: 'entitlement-api', subject_token: await s.idp.userToken('sam.support', 'support-copilot'), ...over }) });
      return ((await res.json()) as { error: string }).error;
    };
    assert.equal(await exchange({ client_secret: 'wrong' }), 'invalid_client');
    assert.equal(await exchange({ client_id: 'constructor' }), 'invalid_client');
    assert.equal(await exchange({ subject_token: t.sam }), 'invalid_grant');
    assert.equal(await exchange({ subject_token: t.agent }), 'invalid_grant');
    s.idp.disabled.add('support-copilot-mcp');
    assert.equal(await exchange({}), 'access_denied');
    s.idp.disabled.clear();
  });
  it('a disabled agent is refused at the API as well', async () => {
    const x = await startStack({ disabledAgents: ['support-copilot-mcp'] });
    try { problem(await x.call('GET', '/v1/cases', { token: await x.agentToken('sam.support') }), 403, 'agent-not-allowed'); } finally { x.stop(); }
  });
});

describe('rate limits', () => {
  it('limits agents harder than people and agent writes hardest', async () => {
    const x = await startStack({ rate: { user: 50, agent: 3, agentWrite: 1, windowMs: 60_000 } });
    try {
      const agent = await x.agentToken('sam.support');
      const write = (k: string): Promise<Reply> => x.call('POST', '/v1/cases/CS-10231/comments', { token: agent, body: { body: 'x' }, headers: { 'idempotency-key': k } });
      assert.equal((await write('write-001')).status, 202);
      const r = await write('write-002');
      problem(r, 429, 'rate-limited');
      assert.ok(Number(r.headers.get('retry-after')) > 0);
      for (let i = 0; i < 3; i++) assert.equal((await x.call('GET', '/v1/cases', { token: agent })).status, 200);
      problem(await x.call('GET', '/v1/cases', { token: agent }), 429, 'rate-limited');
      assert.equal((await x.call('GET', '/v1/cases', { token: await x.user('sam.support') })).status, 200, 'the person is not affected');
    } finally { x.stop(); }
  });
});

describe('audit', () => {
  it('records reads, denials and tool calls with correlation ids, and keeps the chain valid', async () => {
    await get('/v1/customers/ACC-007', t.agent, { 'x-correlation-id': 'corr-12345678' });
    const rec = await s.call('POST', '/v1/agent-tool-calls', { token: t.agent!, body: { callId: 'call-0001', tool: 'search_cases', argsSha256: 'a'.repeat(64), outcome: 'ok', durationMs: 5, resultChars: 100 } });
    assert.equal(rec.status, 201);
    problem(await s.call('POST', '/v1/agent-tool-calls', { token: t.sam!, body: { callId: 'call-0001', tool: 'search_cases', argsSha256: 'a'.repeat(64), outcome: 'ok', durationMs: 5, resultChars: 100 } }), 403, 'forbidden');
    await sleep(20);
    const r = await get('/v1/audit-events?limit=200', t.lena);
    assert.equal(r.body.chainValid, true);
    const read = r.body.data.find((e: any) => e.correlationId === 'corr-12345678');
    assert.deepEqual([read.action, read.actor, read.agent, read.outcome], ['getCustomer', 'sam.support', 'agent:support-copilot-mcp', '200']);
    assert.ok(r.body.data.some((e: any) => e.kind === 'agent_tool' && e.action === 'search_cases'));
    problem(await get('/v1/audit-events'), 403, 'forbidden');
  });
  it('holds no token, ARR or comment text', async () => {
    const dump = JSON.stringify(s.api.db.prepare('SELECT * FROM audit_log').all());
    for (const secret of [t.sam!, '480000', 'Investigating', 'Confidential']) assert.equal(dump.includes(secret), false);
  });
});

describe('contract', () => {
  it('unknown routes are problem+json', async () => {
    const res = await fetch(`${s.apiUrl}/v1/nope`);
    assert.equal(res.status, 404);
    assert.match(res.headers.get('content-type')!, /problem\+json/);
    assert.equal((await fetch(`${s.apiUrl}/v1/cases/%E0%A4%A`)).status, 404);
  });
  it('every operation in openapi.yaml was exercised', () => {
    assert.deepEqual(s.api.spec.operations.map((o) => o.id).filter((id) => !covered.has(id)), []);
  });
});
