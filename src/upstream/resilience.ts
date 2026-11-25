import { setTimeout as sleep } from 'node:timers/promises';
import type { Config } from '../config.ts';
import { log, requestContext } from '../context.ts';

export type FailureReason = 'timeout' | 'circuit_open' | 'upstream_error';

export class UpstreamError extends Error {
  readonly source: string;
  readonly reason: FailureReason;
  constructor(source: string, reason: FailureReason) {
    super(`${source}: ${reason}`);
    this.source = source;
    this.reason = reason;
  }
}

/** Opens after N consecutive failed calls, then lets exactly one probe through after the cooldown. */
export class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;
  private probing = false;
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;

  constructor(threshold: number, cooldownMs: number, now: () => number = Date.now) {
    this.threshold = threshold;
    this.cooldownMs = cooldownMs;
    this.now = now;
  }

  get state(): 'closed' | 'open' | 'half_open' {
    if (this.failures < this.threshold) return 'closed';
    return this.now() - this.openedAt >= this.cooldownMs ? 'half_open' : 'open';
  }

  tryEnter(): boolean {
    if (this.state === 'closed') return true;
    if (this.state === 'open' || this.probing) return false;
    this.probing = true;
    return true;
  }

  success(): void {
    this.failures = 0;
    this.probing = false;
  }

  failure(): void {
    this.failures += 1;
    this.probing = false;
    if (this.failures >= this.threshold) this.openedAt = this.now();
  }
}

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

/** One client per upstream, so one slow system cannot open another's circuit. */
export class UpstreamClient {
  readonly name: string;
  readonly breaker: CircuitBreaker;
  private readonly config: Config;

  constructor(name: string, config: Config) {
    this.name = name;
    this.config = config;
    this.breaker = new CircuitBreaker(config.upstream.breakerThreshold, config.upstream.breakerCooldownMs);
  }

  /**
   * Retries transport errors, timeouts and 5xx/429 with full-jitter backoff. A write is retried only when it carries
   * an idempotency key. Other 4xx answers go back to the caller: the upstream is healthy and gave an answer.
   */
  async request(path: string, init: { method?: string; body?: string; headers?: Record<string, string>; readOnly?: boolean } = {}): Promise<{ status: number; text: string }> {
    if (!this.breaker.tryEnter()) throw new UpstreamError(this.name, 'circuit_open');
    const { readOnly, ...fetchInit } = init;
    const repeatable = readOnly || !init.method || init.method === 'GET' || !!init.headers?.['Idempotency-Key'];
    const { retries, baseDelayMs, timeoutMs } = this.config.upstream;
    let reason: FailureReason = 'upstream_error';
    for (let attempt = 0; attempt <= (repeatable ? retries : 0); attempt++) {
      if (attempt > 0) await sleep(Math.random() * baseDelayMs * 2 ** attempt);
      try {
        const res = await fetch(`${this.config.upstreamUrl}${path}`, {
          ...fetchInit,
          redirect: 'error',
          signal: AbortSignal.timeout(timeoutMs),
          headers: {
            'X-Api-Key': this.config.upstreamKey,
            'X-Correlation-Id': requestContext.getStore()?.correlationId ?? '',
            'Content-Type': 'application/json',
            ...init.headers,
          },
        });
        // Read the body inside the timeout: a stalled body is as bad as a stalled header.
        const text = await res.text();
        if (!RETRYABLE.has(res.status)) {
          this.breaker.success();
          return { status: res.status, text };
        }
        reason = 'upstream_error';
      } catch (err) {
        reason = (err as Error).name === 'TimeoutError' ? 'timeout' : 'upstream_error';
      }
      log.warn({ upstream: this.name, attempt, reason }, 'upstream attempt failed');
    }
    this.breaker.failure();
    throw new UpstreamError(this.name, reason);
  }
}
