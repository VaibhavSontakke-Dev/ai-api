import { createRemoteJWKSet, errors, jwtVerify } from 'jose';
import type { Config } from './config.ts';
import { log } from './context.ts';
import { Problem } from './problem.ts';

export type Principal = { sub: string; scopes: Set<string>; accounts: Set<string> | '*'; agent: string | null; client: string };
export type Verify = (authorization: string | undefined) => Promise<Principal>;

const challenge = { 'WWW-Authenticate': 'Bearer realm="entitlement-api", error="invalid_token"' };

export function createVerifier(config: Config): Verify {
  const jwks = createRemoteJWKSet(new URL(config.jwksUrl), { timeoutDuration: 2000 });
  const disabled = new Set(config.disabledAgents);
  return async (authorization) => {
    const token = /^Bearer ([A-Za-z0-9._-]+)$/.exec(authorization ?? '')?.[1];
    if (!token) throw new Problem('unauthorized', 'Send a bearer token.', {}, challenge);
    let payload;
    try {
      ({ payload } = await jwtVerify(token, jwks, {
        issuer: config.issuer, audience: config.audience, algorithms: ['RS256'], typ: 'at+jwt',
        requiredClaims: ['sub', 'exp', 'scope', 'accounts', 'azp'],
      }));
    } catch (err) {
      // The identity provider being down is not the caller's fault.
      if (err instanceof errors.JWKSTimeout || (err instanceof TypeError && /fetch failed/.test(err.message))) {
        throw new Problem('upstream-unavailable', 'The identity provider is unreachable.', { source: 'identity' }, { 'Retry-After': '5' });
      }
      log.info({ reason: (err as Error).name }, 'token rejected');
      throw new Problem('unauthorized', 'The token is invalid or expired.', {}, challenge);
    }
    const accounts = payload.accounts === '*' ? '*' as const
      : new Set(Array.isArray(payload.accounts) ? payload.accounts.map(String) : []);
    const act = payload.act as { sub?: unknown } | undefined;
    const agent = act ? String(act.sub ?? 'unknown') : null;
    if (agent && disabled.has(agent.replace(/^agent:/, ''))) throw new Problem('agent-not-allowed', 'This agent is disabled.');
    return { sub: String(payload.sub), scopes: new Set(String(payload.scope).split(' ').filter(Boolean)), accounts, agent, client: String(payload.azp) };
  };
}

export const requireScope = (p: Principal, scope: string): void => {
  if (!p.scopes.has(scope)) throw new Problem('forbidden', `This needs the scope ${scope}.`, { requiredScope: scope });
};
export const canSee = (p: Principal, customerId: string): boolean => p.accounts === '*' || p.accounts.has(customerId);
export const requirePerson = (p: Principal): void => {
  if (p.agent) throw new Problem('agent-not-allowed', 'Only a person can decide an action request.');
};
