import { randomBytes } from 'node:crypto';

export type Config = {
  port: number;
  issuer: string;
  jwksUrl: string;
  audience: string;
  upstreamUrl: string;
  upstreamKey: string;
  dbPath: string;
  /** Business clock override so the fixture dates stay meaningful. Token expiry always uses the real clock. */
  demoNow: string | null;
  /** Encrypts webhook secrets at rest and signs cursors. */
  masterKey: Buffer;
  corsOrigins: string[];
  webhookAllowedHosts: string[];
  disabledAgents: string[];
  /** Number of proxy hops, or their addresses. False ignores X-Forwarded-For. */
  trustProxy: number | string[] | false;
  upstream: { timeoutMs: number; retries: number; baseDelayMs: number; breakerThreshold: number; breakerCooldownMs: number };
  cacheTtlMs: number;
  staleMs: number;
  rate: { user: number; agent: number; agentWrite: number; windowMs: number };
  webhook: { pollMs: number; baseDelayMs: number; maxAttempts: number; timeoutMs: number };
};

const list = (v: string | undefined): string[] => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

function parseTrustProxy(v: string | undefined): number | string[] | false {
  if (!v || v === 'false' || v === '0') return false;
  if (v === 'true') throw new Error('TRUST_PROXY must be a number of hops or a list of addresses: trusting every sender lets clients fake their address');
  return /^\d+$/.test(v) ? Number(v) : list(v);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const production = env.NODE_ENV === 'production';
  const required = (name: string, dev: string): string => {
    const v = env[name];
    if (v) return v;
    if (production) throw new Error(`${name} is required in production`);
    return dev;
  };
  const masterKey = env.MASTER_KEY ? Buffer.from(env.MASTER_KEY, 'base64') : production ? Buffer.alloc(0) : randomBytes(32);
  if (masterKey.length !== 32) throw new Error('MASTER_KEY must be 32 bytes, base64');
  return {
    port: Number(env.PORT ?? 4000),
    issuer: required('OIDC_ISSUER', 'http://localhost:4100'),
    jwksUrl: required('OIDC_JWKS_URL', 'http://localhost:4100/.well-known/jwks.json'),
    audience: 'entitlement-api',
    upstreamUrl: required('UPSTREAM_URL', 'http://localhost:4200'),
    upstreamKey: required('UPSTREAM_API_KEY', 'local-mock-key'),
    dbPath: env.DB_PATH ?? ':memory:',
    demoNow: env.DEMO_NOW ?? null,
    masterKey,
    corsOrigins: list(env.CORS_ORIGINS),
    webhookAllowedHosts: list(env.WEBHOOK_ALLOWED_HOSTS),
    disabledAgents: list(env.DISABLED_AGENTS),
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    upstream: { timeoutMs: 1500, retries: 2, baseDelayMs: 100, breakerThreshold: 5, breakerCooldownMs: 10_000 },
    cacheTtlMs: 30_000,
    staleMs: 24 * 3_600_000,
    rate: { user: 120, agent: 60, agentWrite: 10, windowMs: 60_000 },
    webhook: { pollMs: 500, baseDelayMs: 1000, maxAttempts: 6, timeoutMs: 3000 },
  };
}
