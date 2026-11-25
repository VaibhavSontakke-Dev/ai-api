/** Starts the whole stack on ephemeral ports. Every API response that goes through `call` is checked against openapi.yaml. */
import assert from 'node:assert/strict';
import type { AddressInfo, Server } from 'node:net';
import { randomBytes } from 'node:crypto';
import { createApp } from '../app.ts';
import { loadConfig, type Config } from '../config.ts';
import { createMockIdp } from '../mocks/idp.ts';
import { createMockUpstreams, type FaultMode, type FaultTarget } from '../mocks/upstreams.ts';
import type { Express } from 'express';

export const NOW = new Date('2026-11-24T12:00:00Z');
export const AGENT_SECRET = 'test-agent-secret';

const listen = (app: Express): Promise<{ url: string; server: Server }> => new Promise((resolve, reject) => {
  const server = app.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server }));
  server.on('error', reject);
});

export type Reply = { status: number; headers: Headers; body: any };
export type Stack = Awaited<ReturnType<typeof startStack>>;

export async function startStack(overrides: Partial<Config> = {}) {
  let now = NOW;
  const clock = (): Date => now;
  const upstreamKey = 'test-upstream-key';
  const mocks = createMockUpstreams({ apiKey: upstreamKey, now: clock });
  const up = await listen(mocks.app);
  // The issuer is a name, not a URL we listen on, so the ephemeral port does not matter.
  const issuer = 'http://idp.test';
  const idp = await createMockIdp({ issuer, agentSecret: AGENT_SECRET });
  const idpServer = await listen(idp.app);
  const config: Config = {
    ...loadConfig({}), issuer, jwksUrl: `${idpServer.url}/.well-known/jwks.json`, upstreamUrl: up.url, upstreamKey, masterKey: randomBytes(32),
    cacheTtlMs: 0, // every read hits the mock, so faults show immediately
    upstream: { timeoutMs: 150, retries: 2, baseDelayMs: 1, breakerThreshold: 3, breakerCooldownMs: 200 },
    rate: { user: 10_000, agent: 10_000, agentWrite: 10_000, windowMs: 60_000 },
    webhook: { pollMs: 10_000, baseDelayMs: 0, maxAttempts: 3, timeoutMs: 500 },
    ...overrides,
  };
  const api = createApp(config, clock);
  const apiServer = await listen(api.app);

  const agentToken = async (user: string, scope?: string): Promise<string> => {
    const res = await fetch(`${idpServer.url}/token`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange', client_id: 'support-copilot-mcp', client_secret: AGENT_SECRET, audience: 'entitlement-api', subject_token: await idp.userToken(user, 'support-copilot'), ...(scope && { scope }) }),
    });
    const body = await res.json() as { access_token?: string; error?: string };
    if (!body.access_token) throw new Error(body.error);
    return body.access_token;
  };

  const call = async (method: string, path: string, o: { token?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<Reply> => {
    const res = await fetch(`${apiServer.url}${path}`, {
      method,
      headers: { ...(o.token && { authorization: `Bearer ${o.token}` }), ...(o.body !== undefined && { 'content-type': 'application/json' }), ...o.headers },
      ...(o.body !== undefined && { body: typeof o.body === 'string' ? o.body : JSON.stringify(o.body) }),
    });
    const text = await res.text();
    const type = res.headers.get('content-type');
    const body = text ? JSON.parse(text) as unknown : null;
    const violations = api.spec.checkResponse(method, path.split('?')[0]!, res.status, type, body);
    assert.deepEqual(violations, [], `contract violation: ${method} ${path}`);
    return { status: res.status, headers: res.headers, body };
  };

  return {
    api, idp, mocks, config, call, agentToken, apiUrl: apiServer.url, idpUrl: idpServer.url, listen,
    user: (name: string) => idp.userToken(name),
    fault: (t: FaultTarget, m: FaultMode) => { mocks.faults[t] = m; },
    setNow: (d: Date) => { now = d; },
    stop: () => {
      api.webhooks.stop();
      for (const s of [apiServer.server, up.server, idpServer.server]) { (s as unknown as { closeAllConnections(): void }).closeAllConnections(); s.close(); }
      api.db.close();
    },
  };
}
