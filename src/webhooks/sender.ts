/** Outbox-backed webhook sender: at-least-once, signed, with backoff, a dead-letter state and SSRF checks. */
import { randomBytes, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import type { Config } from '../config.ts';
import { log, type Clock } from '../context.ts';
import { Problem } from '../problem.ts';
import type { Audit } from '../services/platform.ts';
import { tx, type Db } from '../store/db.ts';
import { decrypt, encrypt, newSecret, sign } from './signature.ts';

const privateNets = new BlockList();
for (const [net, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3]] as const) privateNets.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [['::', 128], ['::1', 128], ['64:ff9b::', 96], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]] as const) privateNets.addSubnet(net, bits, 'ipv6');

export const isPrivateAddress = (ip: string): boolean => {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)?.[1];
  if (mapped) return privateNets.check(mapped, 'ipv4');
  const v = isIP(ip);
  if (v === 0 || /^::ffff:/i.test(ip)) return true;
  return privateNets.check(ip, v === 4 ? 'ipv4' : 'ipv6');
};

export async function assertTargetAllowed(raw: string, allowedHosts: string[]): Promise<void> {
  const url = new URL(raw);
  const refuse = (why: string): never => { throw new Problem('target-not-allowed', why); };
  if (url.username || url.password) refuse('Credentials in the URL are not allowed.');
  if (allowedHosts.includes(url.host)) return; // operator allowlist, used for the local receiver
  if (url.protocol !== 'https:') refuse('The target must use https.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [host] : await lookup(host, { all: true }).then((a) => a.map((x) => x.address), () => []);
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) refuse('The target must resolve to public addresses only.');
}

const ROTATION_OVERLAP_MS = 24 * 3_600_000;

type DueRow = { id: string; event_id: string; body: string; attempts: number; url: string; secret_enc: Uint8Array; previous_enc: Uint8Array | null };

export class Webhooks {
  private readonly db: Db;
  private readonly config: Config;
  private readonly clock: Clock;
  private readonly audit: Audit;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(db: Db, config: Config, clock: Clock, audit: Audit) {
    this.db = db;
    this.config = config;
    this.clock = clock;
    this.audit = audit;
  }

  async subscribe(url: string, events: string[], createdBy: string): Promise<Record<string, unknown>> {
    await assertTargetAllowed(url, this.config.webhookAllowedHosts);
    const id = `whs_${randomBytes(8).toString('hex')}`;
    const secret = newSecret();
    const createdAt = this.clock().toISOString();
    this.db.prepare('INSERT INTO webhook_subscriptions VALUES (?,?,?,?,?,?)').run(id, url, JSON.stringify(events), encrypt(this.config.masterKey, secret), createdBy, createdAt);
    return { id, url, events, createdAt, secret };
  }

  list(): Record<string, unknown>[] {
    return (this.db.prepare('SELECT id, url, events, created_at FROM webhook_subscriptions ORDER BY created_at').all() as { id: string; url: string; events: string; created_at: string }[])
      .map((s) => ({ id: s.id, url: s.url, events: JSON.parse(s.events) as unknown, createdAt: s.created_at }));
  }

  /** Returns the new secret once. Deliveries carry both signatures for 24 h so receivers can switch without a gap. */
  rotate(id: string): Record<string, unknown> | null {
    const secret = newSecret();
    return tx(this.db, () => {
      const row = this.db.prepare('SELECT secret_enc FROM webhook_subscriptions WHERE id = ?').get(id) as { secret_enc: Uint8Array } | undefined;
      if (!row) return null;
      this.db.prepare('INSERT INTO webhook_previous_secrets VALUES (?,?,?) ON CONFLICT(subscription_id) DO UPDATE SET secret_enc = excluded.secret_enc, expires_at = excluded.expires_at')
        .run(id, row.secret_enc, Date.now() + ROTATION_OVERLAP_MS);
      this.db.prepare('UPDATE webhook_subscriptions SET secret_enc = ? WHERE id = ?').run(encrypt(this.config.masterKey, secret), id);
      return { ...this.list().find((s) => s.id === id)!, secret };
    });
  }

  remove(id: string): boolean {
    return this.db.prepare('DELETE FROM webhook_subscriptions WHERE id = ?').run(id).changes > 0;
  }

  /** Call inside the transaction that records the business change. */
  enqueue(type: 'case.escalated', data: Record<string, unknown>): void {
    const eventId = `evt_${randomUUID()}`;
    const body = JSON.stringify({ id: eventId, type, occurredAt: this.clock().toISOString(), data });
    for (const s of this.list()) {
      if (!(s.events as string[]).includes(type)) continue;
      this.db.prepare("INSERT INTO webhook_deliveries (id,event_id,subscription_id,body,status,next_attempt_at) VALUES (?,?,?,?,'pending',?)").run(randomUUID(), eventId, s.id as string, body, Date.now());
    }
  }

  async deliverDue(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const due = this.db.prepare(`SELECT d.id, d.event_id, d.body, d.attempts, s.url, s.secret_enc, p.secret_enc AS previous_enc FROM webhook_deliveries d
        JOIN webhook_subscriptions s ON s.id = d.subscription_id
        LEFT JOIN webhook_previous_secrets p ON p.subscription_id = s.id AND p.expires_at > ? WHERE d.status = 'pending' AND d.next_attempt_at <= ? ORDER BY d.next_attempt_at LIMIT 20`).all(Date.now(), Date.now()) as unknown as DueRow[];
      await Promise.all(due.map((d) => this.deliver(d)));
    } finally {
      this.running = false;
    }
  }

  private async deliver(d: DueRow): Promise<void> {
    let error: string | null = null;
    try {
      await assertTargetAllowed(d.url, this.config.webhookAllowedHosts); // again: DNS may have changed since subscribe
      const ts = Math.floor(Date.now() / 1000);
      const secrets = [d.secret_enc, ...(d.previous_enc ? [d.previous_enc] : [])].map((b) => decrypt(this.config.masterKey, b));
      const res = await fetch(d.url, {
        method: 'POST', body: d.body, redirect: 'error', signal: AbortSignal.timeout(this.config.webhook.timeoutMs),
        headers: { 'content-type': 'application/json', 'webhook-id': d.event_id, 'webhook-timestamp': String(ts), 'webhook-signature': secrets.map((s) => sign(s, d.event_id, ts, d.body)).join(' ') },
      });
      await res.body?.cancel();
      if (!res.ok) error = `HTTP ${res.status}`;
    } catch (err) {
      error = (err as Error).name === 'TimeoutError' ? 'timeout' : (err as Error).message.slice(0, 200);
    }
    const attempts = d.attempts + 1;
    const status = error === null ? 'delivered' : attempts >= this.config.webhook.maxAttempts ? 'dead' : 'pending';
    const next = Date.now() + this.config.webhook.baseDelayMs * 2 ** d.attempts * (0.5 + Math.random() / 2);
    this.db.prepare('UPDATE webhook_deliveries SET status = ?, attempts = ?, next_attempt_at = ?, last_error = ? WHERE id = ?').run(status, attempts, Math.round(next), error, d.id);
    if (status !== 'pending') this.audit.record({ kind: 'webhook', actor: 'system', action: 'deliver', resource: d.event_id, outcome: status, detail: { attempts, ...(error && { error }) } });
    log[error ? 'warn' : 'info']({ event: d.event_id, attempts, status, error }, 'webhook delivery');
  }

  start(): void {
    this.timer = setInterval(() => { this.deliverDue().catch((err: unknown) => log.error({ err }, 'webhook worker')); }, this.config.webhook.pollMs);
    this.timer.unref();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
