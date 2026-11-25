import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { randomBytes } from 'node:crypto';
import { loadConfig } from '../config.ts';
import { brokenRule, daysBetween, hoursOpen } from '../services/domain.ts';
import { Audit, canonical, Idempotency, RateLimiter } from '../services/platform.ts';
import { redactText } from '../services/redaction.ts';
import { openDb } from '../store/db.ts';
import type { Case } from '../upstream/adapters.ts';
import { CircuitBreaker } from '../upstream/resilience.ts';
import { assertTargetAllowed, isPrivateAddress } from '../webhooks/sender.ts';
import { decrypt, encrypt, newSecret, sign, verify } from '../webhooks/signature.ts';
import { Problem } from '../problem.ts';
import type { Principal } from '../auth.ts';

const now = new Date('2026-11-24T12:00:00Z');
const kase = (o: Partial<Case> = {}): Case => ({ id: 'CS-1', customerId: 'ACC-007', priority: 'P1', status: 'open', openedAt: '2026-11-20T00:00:00Z', subject: 's', comments: [], version: 1, escalation: null, ...o });

describe('time rules', () => {
  it('counts calendar days in UTC, whatever the time of day', () => {
    assert.equal(daysBetween(now, '2027-02-22'), 90);
    assert.equal(daysBetween(new Date('2026-11-24T23:59:59Z'), '2026-11-25'), 1);
    assert.equal(daysBetween(now, '2026-11-24'), 0);
    assert.equal(daysBetween(now, '2026-11-10'), -14);
  });
  it('measures open hours exactly and not at all for finished cases', () => {
    assert.equal(hoursOpen(now, kase({ openedAt: '2026-11-22T12:00:00Z' })), 48);
    assert.equal(hoursOpen(now, kase({ status: 'closed' })), null);
  });
});

describe('escalation rules', () => {
  const lvl = (l: 'L2' | 'L3'): Case['escalation'] => ({ level: l, reason: 'customer_impact', at: now.toISOString() });
  for (const [name, c, level, tier, expected] of [
    ['allows P1 to L2', kase(), 'L2', 'Gold', null],
    ['allows L2 to L3', kase({ escalation: lvl('L2') }), 'L3', 'Gold', null],
    ['refuses skipping a level', kase(), 'L3', 'Gold', 'level'],
    ['refuses repeating a level', kase({ escalation: lvl('L2') }), 'L2', 'Gold', 'level'],
    ['refuses going past L3', kase({ escalation: lvl('L3') }), 'L3', 'Gold', 'level'],
    ['refuses P3', kase({ priority: 'P3' }), 'L2', 'Platinum', 'priority'],
    ['refuses resolved', kase({ status: 'resolved' }), 'L2', 'Platinum', 'status'],
    ['refuses a fresh Gold case', kase({ openedAt: '2026-11-24T08:00:01Z' }), 'L2', 'Gold', 'min_age'],
    ['allows a Gold case at exactly 4 h', kase({ openedAt: '2026-11-24T08:00:00Z' }), 'L2', 'Gold', null],
    ['allows a fresh Platinum case', kase({ openedAt: '2026-11-24T11:59:00Z' }), 'L2', 'Platinum', null],
  ] as const) it(name, () => { assert.equal(brokenRule(c, level, tier, now)?.rule ?? null, expected); });
});

describe('circuit breaker', () => {
  it('opens, lets one probe through after the cooldown, and closes on success', () => {
    let t = 0;
    const b = new CircuitBreaker(2, 100, () => t);
    b.failure(); assert.equal(b.state, 'closed');
    b.failure(); assert.equal(b.state, 'open');
    assert.equal(b.tryEnter(), false);
    t = 100;
    assert.equal(b.tryEnter(), true);
    assert.equal(b.tryEnter(), false, 'only one probe');
    b.failure();
    assert.equal(b.state, 'open', 'a failed probe restarts the cooldown');
    t = 200;
    assert.equal(b.tryEnter(), true);
    b.success();
    assert.equal(b.state, 'closed');
  });
});

describe('rate limiter', () => {
  it('refuses when empty and refills over time', () => {
    let t = 0;
    const r = new RateLimiter(loadConfig({}), () => t);
    assert.equal(r.take('k', 2).allowed, true);
    assert.equal(r.take('k', 2).allowed, true);
    const refused = r.take('k', 2);
    assert.equal(refused.allowed, false);
    assert.equal(refused.retryAfter, 30);
    assert.equal(r.take('other', 2).allowed, true);
    t = 30_000;
    assert.equal(r.take('k', 2).allowed, true);
  });
});

describe('webhook signature', () => {
  const secret = newSecret();
  const headers = (ts: number, sig = sign(secret, 'evt_1', ts, '{}')) => ({ 'webhook-id': 'evt_1', 'webhook-timestamp': String(ts), 'webhook-signature': sig });
  it('accepts a valid signature, also among several during rotation', () => {
    assert.equal(verify(secret, headers(1000), '{}', 1000), true);
    assert.equal(verify(secret, headers(1000, `v1,AAAA ${sign(secret, 'evt_1', 1000, '{}')}`), '{}', 1000), true);
  });
  it('refuses a changed body, changed id, wrong secret, old timestamp and missing headers', () => {
    assert.equal(verify(secret, headers(1000), '{ }', 1000), false);
    assert.equal(verify(secret, { ...headers(1000), 'webhook-id': 'evt_2' }, '{}', 1000), false);
    assert.equal(verify(newSecret(), headers(1000), '{}', 1000), false);
    assert.equal(verify(secret, headers(1000), '{}', 1301), false);
    assert.equal(verify(secret, {}, '{}', 1000), false);
  });
  it('encrypts secrets at rest and detects tampering', () => {
    const key = randomBytes(32);
    const blob = encrypt(key, secret);
    assert.equal(decrypt(key, blob), secret);
    blob[blob.length - 1]! ^= 1;
    assert.throws(() => decrypt(key, blob));
  });
});

describe('webhook target checks', () => {
  it('knows private addresses, including IPv4 inside IPv6', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '192.168.1.1', '172.31.0.1', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', 'nonsense']) assert.equal(isPrivateAddress(ip), true, ip);
    for (const ip of ['8.8.8.8', '2606:4700:4700::1111']) assert.equal(isPrivateAddress(ip), false, ip);
  });
  it('refuses http, credentials and internal targets', async () => {
    for (const url of ['http://8.8.8.8/x', 'https://127.0.0.1/x', 'https://[::1]/x', 'https://169.254.169.254/latest', 'https://u:p@8.8.8.8/', 'https://2130706433/']) {
      await assert.rejects(assertTargetAllowed(url, []), (e) => e instanceof Problem && e.type === 'target-not-allowed', url);
    }
    await assertTargetAllowed('https://8.8.8.8/hook', []);
    await assertTargetAllowed('http://localhost:4300/hooks', ['localhost:4300']);
  });
});

describe('redaction', () => {
  it('removes contact data and secrets but keeps case ids and dates', () => {
    const out = redactText('Mail dana@x.example or +1 415-555-0142, card 4111 1111 1111 1111, host 10.0.0.5, password: hunter2, CS-10231 on 2026-11-24');
    assert.equal(out, 'Mail [email] or [phone], card [number], host [ip], [secret] CS-10231 on 2026-11-24');
  });
  it('removes invisible characters that could hide instructions', () => {
    assert.equal(redactText('a​b‮c\u{E0041}d'), 'abcd');
  });
});

describe('audit log', () => {
  it('is append only, and an edit made around the triggers breaks the chain', async () => {
    const db = openDb(':memory:');
    const a = new Audit(db, () => now);
    for (let i = 0; i < 3; i++) a.record({ kind: 'http', actor: 'x', action: `a${i}`, outcome: '200' });
    assert.equal(await a.verifyAll(), true);
    assert.throws(() => db.exec("UPDATE audit_log SET actor = 'y'"), /append only/);
    assert.throws(() => db.exec('DELETE FROM audit_log'), /append only/);
    db.exec("DROP TRIGGER audit_no_update; UPDATE audit_log SET actor = 'y' WHERE seq = 2");
    assert.equal(await a.verifyAll(), false);
  });
});

describe('idempotency', () => {
  const p: Principal = { sub: 'u', scopes: new Set(), accounts: '*', agent: null, client: 'c' };
  const ok = { status: 201, headers: {}, body: { n: 1 } };

  it('runs once and replays; hash ignores key order', async () => {
    const idem = new Idempotency(openDb(':memory:'));
    let runs = 0;
    const fn = async () => { runs += 1; return ok; };
    assert.equal((await idem.run(p, 'op', 'key-00001', { a: 1, b: 2 }, fn)).replayed, false);
    assert.equal((await idem.run(p, 'op', 'key-00001', { b: 2, a: 1 }, fn)).replayed, true);
    assert.equal(runs, 1);
    await assert.rejects(idem.run(p, 'op', 'key-00001', { a: 2 }, fn), (e) => e instanceof Problem && e.type === 'idempotency-mismatch');
    assert.equal((await idem.run({ ...p, sub: 'other' }, 'op', 'key-00001', { a: 2 }, fn)).replayed, false, 'keys are per caller');
  });
  it('refuses a concurrent duplicate', async () => {
    const idem = new Idempotency(openDb(':memory:'));
    let release!: () => void;
    const first = idem.run(p, 'op', 'key-00001', {}, () => new Promise((r) => { release = () => r(ok); }));
    await assert.rejects(idem.run(p, 'op', 'key-00001', {}, async () => ok), (e) => e instanceof Problem && e.type === 'idempotency-in-progress');
    release();
    await first;
  });
  it('after an unknown outcome, a retry keeps the upstream key and the dispatched mark', async () => {
    const idem = new Idempotency(openDb(':memory:'));
    let key = '';
    await assert.rejects(idem.run(p, 'op', 'key-00001', {}, async (c) => { key = c.upstreamKey; c.markDispatched(); throw new Problem('upstream-unavailable'); }));
    await idem.run(p, 'op', 'key-00001', {}, async (c) => { assert.equal(c.upstreamKey, key); assert.equal(c.dispatched, true); return ok; });
  });
  it('after a definite refusal, a retry runs its checks again', async () => {
    const idem = new Idempotency(openDb(':memory:'));
    for (const dispatch of [false, true]) {
      await assert.rejects(idem.run(p, 'op', 'key-00001', {}, async (c) => { if (dispatch) c.markDispatched(); throw new Problem('escalation-rule'); }));
      await assert.rejects(idem.run(p, 'op', 'key-00001', {}, async (c) => { assert.equal(c.dispatched, false); throw new Problem('not-found'); }), (e) => e instanceof Problem && e.type === 'not-found');
    }
  });
  it('canonical JSON is stable', () => { assert.equal(canonical({ b: [1, { d: 1, c: null }], a: 'x' }), '{"a":"x","b":[1,{"c":null,"d":1}]}'); });
});

describe('configuration', () => {
  it('refuses to start in production with development defaults', () => {
    assert.throws(() => loadConfig({ NODE_ENV: 'production' }), /required in production|MASTER_KEY/);
  });
});
