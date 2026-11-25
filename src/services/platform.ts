/** Cross-cutting services backed by the platform store: audit, idempotency, rate limits. */
import { createHash, randomUUID } from 'node:crypto';
import type { Principal } from '../auth.ts';
import type { Config } from '../config.ts';
import { log, requestContext, type Clock } from '../context.ts';
import { Problem } from '../problem.ts';
import { tx, type Db } from '../store/db.ts';

export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/** Key order must not change a hash. */
export const canonical = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`).join(',')}}`;
  return JSON.stringify(v) ?? 'null';
};

// --- Audit -----------------------------------------------------------------------------------------------------

export type AuditInput = { kind: 'http' | 'agent_tool' | 'action' | 'webhook' | 'data_quality'; actor: string; agent?: string | null; action: string; resource?: string | null; outcome: string; detail?: Record<string, unknown> };
type AuditRow = { seq: number; at: string; kind: string; actor: string; agent: string | null; action: string; resource: string | null; outcome: string; correlation_id: string | null; detail: string; prev_hash: string; hash: string };

/** Append only (enforced by triggers) and hash chained, so an edit made around the triggers is detectable. */
export class Audit {
  private readonly db: Db;
  private readonly clock: Clock;
  constructor(db: Db, clock: Clock) {
    this.db = db;
    this.clock = clock;
  }

  record(e: AuditInput): number {
    const prev = (this.db.prepare('SELECT hash FROM audit_log ORDER BY seq DESC LIMIT 1').get() as { hash: string } | undefined)?.hash ?? 'genesis';
    const row = [this.clock().toISOString(), e.kind, e.actor, e.agent ?? null, e.action, e.resource ?? null, e.outcome, requestContext.getStore()?.correlationId ?? null, JSON.stringify(e.detail ?? {})];
    const r = this.db.prepare('INSERT INTO audit_log (at,kind,actor,agent,action,resource,outcome,correlation_id,detail,prev_hash,hash) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(...row, prev, sha256(canonical([prev, ...row])));
    return Number(r.lastInsertRowid);
  }

  list(q: { limit: number; beforeSeq?: number; kind?: string }): Record<string, unknown>[] {
    const rows = this.db.prepare('SELECT * FROM audit_log WHERE seq < ? AND (? IS NULL OR kind = ?) ORDER BY seq DESC LIMIT ?')
      .all(q.beforeSeq ?? Number.MAX_SAFE_INTEGER, q.kind ?? null, q.kind ?? null, q.limit) as unknown as AuditRow[];
    return rows.map((r) => ({ seq: r.seq, at: r.at, kind: r.kind, actor: r.actor, agent: r.agent, action: r.action, resource: r.resource, outcome: r.outcome, correlationId: r.correlation_id, detail: JSON.parse(r.detail) as unknown }));
  }

  // Verification. A page load checks only what is new; the whole trail is checked in the background.
  private checkpoint = { seq: 0, hash: 'genesis' };
  private broken = false;
  private timer: NodeJS.Timeout | null = null;
  lastChecked = 0;
  fullyVerifiedAt: string | null = null;

  private static follows(prev: { seq: number; hash: string }, r: AuditRow): boolean {
    const expected = sha256(canonical([prev.hash, r.at, r.kind, r.actor, r.agent, r.action, r.resource, r.outcome, r.correlation_id, r.detail]));
    return r.prev_hash === prev.hash && r.hash === expected && r.seq === prev.seq + 1;
  }

  /** Also recomputes the last row checked before, so removing or editing it is noticed while the process runs. */
  verifyNew(): boolean {
    if (this.broken) return false;
    const last = this.checkpoint;
    if (last.seq > 0) {
      const row = this.db.prepare('SELECT * FROM audit_log WHERE seq = ?').get(last.seq) as unknown as AuditRow | undefined;
      if (!row || row.hash !== last.hash || !Audit.follows({ seq: last.seq - 1, hash: row.prev_hash }, row)) this.broken = true;
    }
    this.lastChecked = 0;
    for (const r of this.db.prepare('SELECT * FROM audit_log WHERE seq > ? ORDER BY seq').iterate(last.seq) as unknown as Iterable<AuditRow>) {
      if (this.broken || !Audit.follows(this.checkpoint, r)) { this.broken = true; break; }
      this.checkpoint = { seq: r.seq, hash: r.hash };
      this.lastChecked += 1;
    }
    return !this.broken;
  }

  /** Everything from the first row, in batches so requests are not held up. A break is remembered. */
  async verifyAll(batch = 1000): Promise<boolean> {
    let prev = { seq: 0, hash: 'genesis' };
    for (;;) {
      const rows = this.db.prepare('SELECT * FROM audit_log WHERE seq > ? ORDER BY seq LIMIT ?').all(prev.seq, batch) as unknown as AuditRow[];
      for (const r of rows) {
        if (!Audit.follows(prev, r)) { this.broken = true; return false; }
        prev = { seq: r.seq, hash: r.hash };
      }
      if (rows.length < batch) break;
      await new Promise((resolve) => { setImmediate(resolve); });
    }
    this.fullyVerifiedAt = this.clock().toISOString();
    return this.verifyNew();
  }

  start(everyMs = 600_000): void {
    const run = (): void => { this.verifyAll().then((ok) => { if (!ok) log.error('audit chain is broken'); }, (err: unknown) => log.error({ err }, 'audit verification')); };
    run();
    this.timer = setInterval(run, everyMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}

// --- Idempotency -----------------------------------------------------------------------------------------------

export type Stored = { status: number; headers: Record<string, string>; body: unknown };
export type WriteContext = { upstreamKey: string; dispatched: boolean; markDispatched: () => void };
const LOCK_MS = 30_000;
const TTL_MS = 24 * 3_600_000;

export class Idempotency {
  private readonly db: Db;
  constructor(db: Db) { this.db = db; }

  /**
   * Runs `fn` once per (caller, operation, key) and stores successes only.
   *
   * The hard case is a crash or timeout after the upstream applied the write. The record then stays, marked
   * `dispatched`, and a retry skips the local checks (they would now fail against the changed case) and resends with
   * the same upstream key, which the upstream deduplicates. Any definite refusal deletes the record, so a retry can
   * never skip checks that did not pass.
   *
   * `commit` runs in the transaction that completes the record (webhook outbox and audit).
   */
  async run(p: Principal, operation: string, key: string, request: unknown, fn: (ctx: WriteContext) => Promise<Stored & { commit?: () => void }>): Promise<Stored & { replayed: boolean }> {
    const id = [`${p.client}|${p.agent ?? ''}|${p.sub}`, operation, key] as const;
    const where = 'caller = ? AND operation = ? AND key = ?';
    const hash = sha256(canonical(request));
    const now = Date.now();
    const claim = tx(this.db, () => {
      this.db.prepare('DELETE FROM idempotency_records WHERE expires_at < ?').run(now);
      const row = this.db.prepare(`SELECT * FROM idempotency_records WHERE ${where}`).get(...id) as
        { request_hash: string; upstream_key: string; state: string; status: number; headers: string; body: string; locked_until: number; dispatched: number } | undefined;
      if (!row) {
        const upstreamKey = randomUUID();
        this.db.prepare("INSERT INTO idempotency_records (caller,operation,key,request_hash,upstream_key,state,locked_until,expires_at) VALUES (?,?,?,?,?,'in_progress',?,?)")
          .run(...id, hash, upstreamKey, now + LOCK_MS, now + TTL_MS);
        return { upstreamKey, dispatched: false };
      }
      if (row.request_hash !== hash) throw new Problem('idempotency-mismatch', 'This Idempotency-Key was used with a different request.');
      if (row.state === 'completed') return { stored: { status: row.status, headers: JSON.parse(row.headers) as Record<string, string>, body: JSON.parse(row.body) as unknown } };
      if (row.locked_until > now) throw new Problem('idempotency-in-progress', 'The first request with this key is still running.', {}, { 'Retry-After': '2' });
      this.db.prepare(`UPDATE idempotency_records SET locked_until = ? WHERE ${where}`).run(now + LOCK_MS, ...id);
      return { upstreamKey: row.upstream_key, dispatched: row.dispatched === 1 };
    });
    if (claim.stored) return { ...claim.stored, replayed: true };
    const ctx: WriteContext = {
      upstreamKey: claim.upstreamKey, dispatched: claim.dispatched,
      markDispatched: () => {
        ctx.dispatched = true;
        this.db.prepare(`UPDATE idempotency_records SET dispatched = 1 WHERE ${where}`).run(...id);
      },
    };
    try {
      const { commit, ...out } = await fn(ctx);
      tx(this.db, () => {
        commit?.();
        this.db.prepare(`UPDATE idempotency_records SET state = 'completed', status = ?, headers = ?, body = ? WHERE ${where}`)
          .run(out.status, JSON.stringify(out.headers), JSON.stringify(out.body), ...id);
      });
      return { ...out, replayed: false };
    } catch (err) {
      const unknownOutcome = ctx.dispatched && !(err instanceof Problem && err.status < 500);
      if (unknownOutcome) this.db.prepare(`UPDATE idempotency_records SET locked_until = 0 WHERE ${where}`).run(...id);
      else this.db.prepare(`DELETE FROM idempotency_records WHERE ${where}`).run(...id);
      throw err;
    }
  }
}

// --- Rate limits -----------------------------------------------------------------------------------------------

/** Token bucket in memory. With several instances this moves to Redis (see DECISIONS.md). */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  private readonly windowMs: number;
  private readonly now: () => number;
  constructor(config: Config, now: () => number = Date.now) {
    this.windowMs = config.rate.windowMs;
    this.now = now;
  }

  take(key: string, limit: number): { allowed: boolean; headers: Record<string, string>; retryAfter: number } {
    const now = this.now();
    const b = this.buckets.get(key) ?? { tokens: limit, at: now };
    b.tokens = Math.min(limit, b.tokens + ((now - b.at) / this.windowMs) * limit);
    b.at = now;
    const allowed = b.tokens >= 1;
    if (allowed) b.tokens -= 1;
    this.buckets.set(key, b);
    if (this.buckets.size > 10_000) {
      for (const [k, v] of this.buckets) if (now - v.at > this.windowMs) this.buckets.delete(k);
    }
    const perToken = this.windowMs / limit / 1000;
    return {
      allowed, retryAfter: Math.max(1, Math.ceil((1 - b.tokens) * perToken)),
      headers: { 'RateLimit-Limit': String(limit), 'RateLimit-Remaining': String(Math.floor(b.tokens)), 'RateLimit-Reset': String(Math.ceil((limit - b.tokens) * perToken)) },
    };
  }
}
