/** `npm start`: API, mock upstreams, mock identity provider and a sample webhook receiver in one process. */
import type { AddressInfo } from 'node:net';
import { createApp } from './app.ts';
import { loadConfig } from './config.ts';
import { log, makeClock } from './context.ts';
import { createMockIdp } from './mocks/idp.ts';
import { createMockUpstreams } from './mocks/upstreams.ts';
import { createReceiver } from './webhooks/receiver.ts';

process.env.DEMO_NOW ??= '2026-11-24T12:00:00Z';
process.env.DB_PATH ??= ':memory:';
process.env.WEBHOOK_ALLOWED_HOSTS ??= 'localhost:4300';
process.env.CORS_ORIGINS ??= 'http://localhost:3000';

const host = process.env.HOST ?? '127.0.0.1'; // loopback: the mock IdP must never be reachable from the network
const config = loadConfig();
const clock = makeClock(config.demoNow);

const idp = await createMockIdp({ issuer: config.issuer, agentSecret: process.env.AGENT_CLIENT_SECRET ?? 'local-agent-secret', consoleSecret: process.env.CONSOLE_CLIENT_SECRET ?? 'local-console-secret', accessTtlSeconds: Number(process.env.ACCESS_TTL_SECONDS ?? 3600) });
const upstreams = createMockUpstreams({ apiKey: config.upstreamKey, now: clock });
const api = createApp(config, clock);

let secret: string | null = null;
const receiver = createReceiver(() => secret, (event) => log.info({ event }, 'receiver: verified case.escalated'));
const sub = await api.webhooks.subscribe('http://localhost:4300/hooks', ['case.escalated'], 'dev-bootstrap');
secret = String(sub.secret);

const servers = [
  ['mock identity provider', idp.app.listen(4100, host)],
  ['mock upstreams', upstreams.app.listen(4200, host)],
  ['sample webhook receiver', receiver.listen(4300, host)],
  ['API', api.app.listen(config.port, host)],
] as const;
for (const [name, s] of servers) {
  s.on('listening', () => log.info({ port: (s.address() as AddressInfo).port }, `${name} ready`));
  s.on('error', (err) => { log.error({ err }, `${name} failed to start`); process.exit(1); });
}
api.webhooks.start();
api.audit.start();

const stop = (): void => {
  api.webhooks.stop();
  api.audit.stop();
  for (const [, s] of servers) s.close();
  api.db.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
