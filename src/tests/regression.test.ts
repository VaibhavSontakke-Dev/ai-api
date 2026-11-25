/** Gaps found by review after the first version. Each test failed before its fix. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../../mcp/server.ts';
import { loadConfig } from '../config.ts';
import { Audit } from '../services/platform.ts';
import { openDb } from '../store/db.ts';
import { createReceiver } from '../webhooks/receiver.ts';
import { AGENT_SECRET, NOW, startStack, type Reply, type Stack } from './harness.ts';

const stack = async (fn: (s: Stack) => Promise<void>, o: Parameters<typeof startStack>[0] = {}): Promise<void> => {
  const s = await startStack(o);
  try { await fn(s); } finally { s.stop(); }
};
const copilot = async (s: Stack, user: string): Promise<(name: string, args: object) => Promise<any>> => {
  const server = createMcpServer({ apiUrl: s.apiUrl, tokenUrl: `${s.idpUrl}/token`, clientId: 'support-copilot-mcp', clientSecret: AGENT_SECRET, userToken: await s.idp.userToken(user, 'support-copilot') });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 't', version: '1' });
  await Promise.all([server.connect(a), client.connect(b)]);
  return async (name, args) => JSON.parse(((await client.callTool({ name, arguments: args as Record<string, unknown> })).content as { text: string }[])[0]!.text);
};
const COMMENT = { case_id: 'CS-10231', body: 'Same text every time' };

describe('repeated proposals report the real state', () => {
  const decide = async (s: Stack, id: string, what: string): Promise<Reply> => s.call('POST', `/v1/action-requests/${id}/${what}`, { token: await s.user('sam.support') });

  it('after a rejection: says rejected and creates nothing new', () => stack(async (s) => {
    const call = await copilot(s, 'sam.support');
    const first = await call('add_case_comment', COMMENT);
    await decide(s, first.action_request_id, 'reject');
    const again = await call('add_case_comment', COMMENT);
    assert.equal(again.status, 'rejected');
    assert.match(again.message, /rejected/);
    assert.equal(again.action_request_id, first.action_request_id);
  }));
  it('after execution: says done and does not write twice', () => stack(async (s) => {
    const call = await copilot(s, 'sam.support');
    const first = await call('add_case_comment', COMMENT);
    await decide(s, first.action_request_id, 'approve');
    assert.equal((await call('add_case_comment', COMMENT)).status, 'executed');
    assert.equal((await s.api.upstreams.getCase('CS-10231'))!.comments.length, 2);
  }));
  it('after expiry: makes a fresh proposal, and repeating that one does not add a third', () => stack(async (s) => {
    const call = await copilot(s, 'sam.support');
    const first = await call('add_case_comment', COMMENT);
    s.setNow(new Date(NOW.getTime() + 31 * 60_000));
    const second = await call('add_case_comment', COMMENT);
    assert.equal(second.status, 'waiting_for_human_approval');
    assert.notEqual(second.action_request_id, first.action_request_id);
    assert.equal((await call('add_case_comment', COMMENT)).action_request_id, second.action_request_id);
  }));
});

describe('approvals list', () => {
  it('finds an old request of this user behind 1,500 newer ones of others', () => stack(async (s) => {
    const r = await s.call('POST', '/v1/cases/CS-10231/comments', { token: await s.agentToken('carl.csm'), body: { body: 'Old one' }, headers: { 'idempotency-key': 'old-request-1' } });
    const add = s.api.db.prepare("INSERT INTO action_requests VALUES (?,'add_comment','CS-10250','ACC-019',1,'{\"body\":\"x\"}','pending','sam.support','agent:support-copilot-mcp',NULL,NULL,?,?)");
    for (let i = 0; i < 1500; i++) add.run(`act_${i.toString(16).padStart(16, '0')}`, new Date(NOW.getTime() + 1000 + i).toISOString(), new Date(NOW.getTime() + 9e6).toISOString());
    const list = async (user: string, q = ''): Promise<any[]> => (await s.call('GET', `/v1/action-requests${q}`, { token: await s.user(user) })).body.data;
    assert.deepEqual((await list('carl.csm')).map((x) => x.id), [r.body.id]);
    assert.equal((await list('lena.lead')).length, 100);
    s.setNow(new Date(NOW.getTime() + 31 * 60_000));
    assert.deepEqual((await list('carl.csm', '?status=expired')).map((x) => x.id), [r.body.id]);
    assert.deepEqual(await list('carl.csm', '?status=pending'), []);
  }));
});

describe('audit verification', () => {
  const fill = (n: number): { db: ReturnType<typeof openDb>; a: Audit } => {
    const db = openDb(':memory:');
    const a = new Audit(db, () => NOW);
    for (let i = 0; i < n; i++) a.record({ kind: 'http', actor: 'x', action: `a${i}`, outcome: '200' });
    return { db, a };
  };
  it('checks only new rows on a page load', () => {
    const { db, a } = fill(2000);
    assert.equal(a.verifyNew(), true);
    a.record({ kind: 'http', actor: 'x', action: 'late', outcome: '200' });
    assert.equal(a.verifyNew(), true);
    assert.equal(a.lastChecked, 1);
    db.exec("DROP TRIGGER audit_no_update; UPDATE audit_log SET actor = 'y' WHERE seq = 2001");
    assert.equal(a.verifyNew(), false, 'the newest checked row is always compared');
  });
  it('the full check finds an old edit, and the result stays broken', async () => {
    const { db, a } = fill(2500);
    assert.equal(a.verifyNew(), true);
    db.exec("DROP TRIGGER audit_no_update; UPDATE audit_log SET actor = 'y' WHERE seq = 2");
    assert.equal(await a.verifyAll(), false);
    assert.equal(a.verifyNew(), false);
  });
  it('notices newest rows removed while running', () => {
    const { db, a } = fill(5);
    a.verifyNew();
    db.exec('DROP TRIGGER audit_no_delete; DELETE FROM audit_log WHERE seq = 5');
    assert.equal(a.verifyNew(), false);
  });
  it('the API says when the whole trail was last checked', () => stack(async (s) => {
    const read = async (): Promise<any> => (await s.call('GET', '/v1/audit-events', { token: await s.user('lena.lead') })).body;
    assert.equal((await read()).fullyVerifiedAt, null);
    await s.api.audit.verifyAll();
    assert.equal((await read()).fullyVerifiedAt, NOW.toISOString());
  }));
});

describe('client address behind a proxy', () => {
  const hammer = async (s: Stack, ip: string): Promise<number[]> => {
    const out: number[] = [];
    for (let i = 0; i < 12; i++) out.push((await fetch(`${s.apiUrl}/v1/cases`, { headers: { 'x-forwarded-for': ip } })).status);
    return out;
  };
  const rate = { user: 1, agent: 1, agentWrite: 1, windowMs: 60_000 };
  it('with a trusted hop, one client cannot use up the limit of another', () => stack(async (s) => {
    assert.ok((await hammer(s, '203.0.113.1')).includes(429));
    assert.equal((await hammer(s, '203.0.113.2'))[0], 401);
  }, { rate, trustProxy: 1 }));
  it('without one, the header is ignored, so it cannot be used to dodge the limit', () => stack(async (s) => {
    await hammer(s, '203.0.113.1');
    assert.equal((await hammer(s, '203.0.113.2'))[0], 429);
  }, { rate }));
  it('refuses to trust everyone', () => {
    assert.throws(() => loadConfig({ TRUST_PROXY: 'true' }), /TRUST_PROXY/);
    assert.equal(loadConfig({ TRUST_PROXY: '2' }).trustProxy, 2);
    assert.deepEqual(loadConfig({ TRUST_PROXY: '10.0.0.0/8, 192.0.2.1' }).trustProxy, ['10.0.0.0/8', '192.0.2.1']);
  });
});

describe('case paging does not read everything', () => {
  const many = (s: Stack, n: number): void => s.mocks.addCases(n);
  for (const sort of ['openedAt', '-openedAt', 'priority'] as const) {
    it(`reads about one page for ${sort}, whatever the total`, () => stack(async (s) => {
      many(s, 8000);
      const token = await s.user('sam.support');
      s.mocks.stats.records = 0;
      const r = await s.call('GET', `/v1/cases?sort=${sort}&limit=20`, { token });
      assert.equal(r.status, 200);
      assert.equal(r.body.data.length, 20);
      assert.ok(s.mocks.stats.records <= 100, `${s.mocks.stats.records} records read`);
      const next = await s.call('GET', `/v1/cases?sort=${sort}&limit=20&cursor=${r.body.meta.nextCursor}`, { token });
      assert.equal(new Set([...r.body.data, ...next.body.data].map((c: any) => c.id)).size, 40);
    }));
  }
  it('pages 400 cases completely and in order for every sort, with a filter', () => stack(async (s) => {
    many(s, 383);
    const token = await s.user('sam.support');
    for (const sort of ['openedAt', '-openedAt', 'priority', 'renewalDate']) {
      const seen: any[] = [];
      let cursor = '';
      do {
        const r = await s.call('GET', `/v1/cases?sort=${sort}&limit=37&priority=P1,P2,P3,P4${cursor && `&cursor=${cursor}`}`, { token });
        assert.equal(r.status, 200);
        seen.push(...r.body.data);
        cursor = r.body.meta.nextCursor ?? '';
      } while (cursor);
      assert.equal(seen.length, 400, sort);
      assert.equal(new Set(seen.map((c) => c.id)).size, 400, sort);
      const key = (c: any): string => (sort === 'priority' ? c.priority : sort === 'renewalDate' ? c.customer.renewalDate ?? '9999' : c.openedAt);
      for (let i = 1; i < seen.length; i++) {
        const [a, b] = [key(seen[i - 1]), key(seen[i])];
        assert.ok(sort === '-openedAt' ? a >= b : a <= b, `${sort} at ${i}: ${a} ${b}`);
      }
    }
  }));
  it('a case of a customer without entitlement is listed last, not lost', () => stack(async (s) => {
    s.mocks.addCases(1, 'ACC-900');
    const r = await s.call('GET', '/v1/cases?sort=renewalDate&limit=100', { token: await s.user('sam.support') });
    assert.equal(r.body.data.length, 18);
    assert.equal(r.body.data.at(-1).customer.id, 'ACC-900');
    assert.equal(r.body.data.at(-1).customer.renewalDate, null);
  }));
  it('an upstream that answers out of order is an error, not a wrong page', () => stack(async (s) => {
    s.mocks.stats.shuffle = true;
    assert.equal((await s.call('GET', '/v1/cases', { token: await s.user('sam.support') })).status, 503);
  }));
});

describe('deprecation headers', () => {
  it('come from the contract', () => stack(async (s) => {
    const op = s.api.spec.operations.find((o) => o.id === 'getCase')!;
    op.deprecation = { deprecatedAt: '2027-01-01', sunset: '2028-01-01', successor: '/v2/cases/{caseId}' };
    const r = await s.call('GET', '/v1/cases/CS-10231', { token: await s.user('sam.support') });
    assert.equal(r.headers.get('deprecation'), `@${Date.parse('2027-01-01') / 1000}`);
    assert.equal(r.headers.get('sunset'), 'Sat, 01 Jan 2028 00:00:00 GMT');
    assert.equal(r.headers.get('link'), '</v2/cases/{caseId}>; rel="successor-version"');
    assert.equal((await s.call('GET', '/v1/cases', { token: await s.user('sam.support') })).headers.get('deprecation'), null);
  }));
});

describe('webhook secret rotation', () => {
  it('signs with both secrets during the overlap, then only with the new one', () => stack(async (s) => {
    let secret = '';
    const got: string[] = [];
    const { url, server } = await s.listen(createReceiver(() => secret, (e) => got.push((e as { id: string }).id)));
    try {
    s.config.webhookAllowedHosts.push(new URL(url).host);
    const token = await s.user('lena.lead');
    const sub = (await s.call('POST', '/v1/webhook-subscriptions', { token, body: { url: `${url}/hooks`, events: ['case.escalated'] } })).body;
    const rotated = await s.call('POST', `/v1/webhook-subscriptions/${sub.id}/rotate-secret`, { token });
    assert.equal(rotated.status, 200);
    assert.notEqual(rotated.body.secret, sub.secret);
    const deliver = async (use: string): Promise<number> => {
      secret = use;
      const before = got.length;
      s.api.webhooks.enqueue('case.escalated', {});
      await s.api.webhooks.deliverDue();
      return got.length - before;
    };
    assert.equal(await deliver(sub.secret), 1, 'a receiver that still has the old secret');
    assert.equal(await deliver(rotated.body.secret), 1);
    s.api.db.exec('UPDATE webhook_previous_secrets SET expires_at = 1');
    assert.equal(await deliver(sub.secret), 0, 'the old secret has ended');
    assert.equal(await deliver(rotated.body.secret), 2, 'this event, and the refused one on its retry');
    assert.equal((await s.call('POST', `/v1/webhook-subscriptions/${sub.id}/rotate-secret`, { token: await s.user('sam.support') })).status, 403);
    assert.equal((await s.call('POST', '/v1/webhook-subscriptions/whs_0000000000000000/rotate-secret', { token })).status, 404);
    } finally {
      (server as unknown as { closeAllConnections(): void }).closeAllConnections();
      server.close();
    }
  }));
});

describe('console session refresh', () => {
  const post = async (s: Stack, path: string, body: object): Promise<{ status: number; body: any }> => {
    const r = await fetch(`${s.idpUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const refresh = (s: Stack, refresh_token: string, over = {}): Promise<{ status: number; body: any }> =>
    post(s, '/token', { grant_type: 'refresh_token', client_id: 'console', client_secret: 'local-console-secret', refresh_token, ...over });

  it('gives the console a new access token until it is revoked', () => stack(async (s) => {
    const login = (await post(s, '/dev/login', { user: 'sam.support' })).body;
    const r = await refresh(s, login.refresh_token);
    assert.equal(r.status, 200);
    assert.equal((await s.call('GET', '/v1/cases', { token: r.body.access_token })).status, 200);
    assert.equal((await refresh(s, login.refresh_token, { client_secret: 'wrong' })).body.error, 'invalid_client');
    assert.equal((await refresh(s, login.refresh_token, { client_id: 'support-copilot-mcp', client_secret: AGENT_SECRET })).body.error, 'unsupported_grant_type');
    await post(s, '/revoke', { client_id: 'console', client_secret: 'local-console-secret', token: login.refresh_token });
    assert.equal((await refresh(s, login.refresh_token)).body.error, 'invalid_grant');
  }));
  it('is never given to the copilot', () => stack(async (s) => {
    assert.equal((await post(s, '/dev/login', { user: 'sam.support', audience: 'support-copilot' })).body.refresh_token, undefined);
  }));
  it('the console client cannot exchange tokens', () => stack(async (s) => {
    const r = await post(s, '/token', { grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange', client_id: 'console', client_secret: 'local-console-secret', audience: 'entitlement-api', subject_token: await s.idp.userToken('sam.support', 'support-copilot') });
    assert.equal(r.body.error, 'unsupported_grant_type');
  }));
});

