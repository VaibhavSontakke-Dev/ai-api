import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { createVerifier, requireScope, type Principal } from './auth.ts';
import type { Config } from './config.ts';
import { log, makeClock, requestContext, type Clock } from './context.ts';
import { Problem } from './problem.ts';
import { Domain, type CaseQuery } from './services/domain.ts';
import { Audit, Idempotency, RateLimiter, type Stored } from './services/platform.ts';
import { Spec, type ValidInput } from './spec.ts';
import { openDb } from './store/db.ts';
import { Upstreams } from './upstream/adapters.ts';
import { Webhooks } from './webhooks/sender.ts';

type Ctx = { p: Principal; input: ValidInput; req: Request; res: Response };
type Handler = (ctx: Ctx) => Promise<void> | void;

export function createApp(config: Config, clock: Clock = makeClock(config.demoNow)) {
  const spec = new Spec();
  const db = openDb(config.dbPath);
  const audit = new Audit(db, clock);
  const verify = createVerifier(config);
  const limiter = new RateLimiter(config);
  const webhooks = new Webhooks(db, config, clock, audit);
  const upstreams = new Upstreams(config, db, (message, resource) => {
    audit.record({ kind: 'data_quality', actor: 'system', action: 'quarantine', resource, outcome: 'quarantined', detail: { message } });
  });
  const domain = new Domain({ config, db, clock, upstreams, audit, idempotency: new Idempotency(db), webhooks });

  const sendStored = (res: Response, r: Stored & { replayed: boolean }): void => {
    if (r.replayed) res.set('Idempotent-Replayed', 'true');
    res.status(r.status).set(r.headers).json(r.body);
  };

  /** Keyed by operationId. Start-up fails if the contract and this table disagree. */
  const handlers: Record<string, Handler> = {
    health: ({ res }) => { res.json({ status: 'ok' }); },
    ready: ({ res }) => {
      const circuits = upstreams.circuits();
      res.json({ status: Object.values(circuits).every((s) => s === 'closed') ? 'ok' : 'degraded', upstreams: circuits });
    },
    getCustomer: async ({ p, input, res }) => { res.json(await domain.customer(p, input.path.customerId!)); },
    listCases: async ({ p, input, res }) => { res.json(await domain.listCases(p, input.query as CaseQuery)); },
    getCase: async ({ p, input, req, res }) => {
      const { etag, body } = await domain.getCase(p, input.path.caseId!);
      res.set('ETag', etag);
      if (req.get('if-none-match') === etag) { res.status(304).end(); return; }
      res.json(body);
    },
    addCaseComment: async ({ p, input, req, res }) => {
      sendStored(res, await domain.addComment(p, input.path.caseId!, req.body, input.headers['Idempotency-Key']!));
    },
    escalateCase: async ({ p, input, req, res }) => {
      sendStored(res, await domain.escalate(p, input.path.caseId!, req.body, input.headers['Idempotency-Key']!, input.headers['If-Match']));
    },
    listActionRequests: ({ p, input, res }) => { res.json(domain.listActions(p, input.query.status)); },
    getActionRequest: ({ p, input, res }) => { res.json(domain.getAction(p, input.path.actionRequestId!)); },
    approveActionRequest: async ({ p, input, res }) => { res.json(await domain.approve(p, input.path.actionRequestId!)); },
    rejectActionRequest: ({ p, input, res }) => { res.json(domain.reject(p, input.path.actionRequestId!)); },
    listWebhookSubscriptions: ({ res }) => { res.json({ data: webhooks.list() }); },
    createWebhookSubscription: async ({ p, req, res }) => {
      const s = await webhooks.subscribe(req.body.url, req.body.events, p.sub);
      audit.record({ kind: 'webhook', actor: p.sub, action: 'subscribe', resource: String(s.id), outcome: 'created' });
      res.status(201).json(s);
    },
    rotateWebhookSecret: ({ p, input, res }) => {
      const s = webhooks.rotate(input.path.subscriptionId!);
      if (!s) throw new Problem('not-found');
      audit.record({ kind: 'webhook', actor: p.sub, action: 'rotate_secret', resource: input.path.subscriptionId!, outcome: 'rotated' });
      res.json(s);
    },
    deleteWebhookSubscription: ({ p, input, res }) => {
      if (!webhooks.remove(input.path.subscriptionId!)) throw new Problem('not-found');
      audit.record({ kind: 'webhook', actor: p.sub, action: 'unsubscribe', resource: input.path.subscriptionId!, outcome: 'deleted' });
      res.status(204).end();
    },
    recordAgentToolCall: ({ p, req, res }) => {
      if (!p.agent) throw new Problem('forbidden', 'Only agent tokens can record tool calls.');
      const { tool, outcome, ...detail } = req.body as { tool: string; outcome: string };
      res.status(201).json({ seq: audit.record({ kind: 'agent_tool', actor: p.sub, agent: p.agent, action: tool, outcome, detail }) });
    },
    listAuditEvents: ({ input, res }) => { res.json({ data: audit.list(input.query as { limit: number }), chainValid: audit.verifyNew(), fullyVerifiedAt: audit.fullyVerifiedAt }); },
  };
  for (const op of spec.operations) if (!handlers[op.id]) throw new Error(`no handler for ${op.id}`);

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.disable('etag'); // ETags are case versions, not body hashes

  app.use((req, res, next) => {
    const given = req.get('x-correlation-id');
    const correlationId = given && /^[A-Za-z0-9-]{8,64}$/.test(given) ? given : randomUUID();
    res.locals.correlationId = correlationId;
    res.set({ 'X-Correlation-Id': correlationId, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'", 'Referrer-Policy': 'no-referrer' });
    requestContext.run({ correlationId }, next);
  });
  app.use(cors({ origin: config.corsOrigins, exposedHeaders: ['ETag', 'X-Correlation-Id', 'Retry-After', 'Deprecation', 'Sunset', 'Link'] }));

  app.use(async (req, res) => {
    const started = performance.now();
    const match = spec.match(req.method, req.path);
    let principal: Principal | null = null;
    const isHealth = match?.op.scopes === null;
    res.on('finish', () => {
      const ms = Math.round(performance.now() - started);
      log.info({ method: req.method, route: match?.op.path ?? 'unmatched', status: res.statusCode, ms, actor: principal?.sub, agent: principal?.agent ?? undefined }, 'request');
      if (isHealth) return;
      try {
        audit.record({ kind: 'http', actor: principal?.sub ?? 'anonymous', agent: principal?.agent ?? null, action: match ? match.op.id : 'unmatched', resource: match ? Object.values(match.path)[0] ?? null : null, outcome: String(res.statusCode), detail: { ms, problem: res.locals.problem } });
      } catch (err) {
        log.error({ err }, 'audit write failed');
      }
    });

    // Before authentication, so token guessing is limited too.
    const ip = limiter.take(`ip:${req.ip}`, config.rate.user * 10);
    if (!ip.allowed) throw new Problem('rate-limited', undefined, {}, { 'Retry-After': String(ip.retryAfter) });
    if (!match) throw new Problem('not-found', 'No such route.');
    const { op } = match;
    if (op.deprecation) {
      const d = op.deprecation;
      res.set({ Deprecation: `@${Date.parse(d.deprecatedAt) / 1000}`, Sunset: new Date(d.sunset).toUTCString(), Link: `<${d.successor}>; rel="successor-version"` });
    }

    if (op.scopes !== null) {
      const p = await verify(req.get('authorization'));
      principal = p;
      const write = p.agent !== null && req.method === 'POST' && op.id !== 'recordAgentToolCall';
      const [bucket, limit] = write ? ['agent-write', config.rate.agentWrite] as const
        : op.id === 'recordAgentToolCall' ? ['agent-audit', config.rate.agent * 4] as const
          : p.agent ? ['agent', config.rate.agent] as const : ['user', config.rate.user] as const;
      const r = limiter.take(`${bucket}:${p.agent ?? p.client}:${p.sub}`, limit);
      res.set(r.headers);
      if (!r.allowed) throw new Problem('rate-limited', `Limit of ${limit} per minute reached.`, {}, { 'Retry-After': String(r.retryAfter) });
      for (const s of op.scopes) requireScope(p, s);
    }

    if (op.body) {
      await new Promise<void>((resolve, reject) => {
        express.json({ limit: '32kb', type: 'application/json' })(req, res, (err?: unknown) => {
          if (!err) { resolve(); return; }
          const tooLarge = (err as { type?: string }).type === 'entity.too.large';
          reject(tooLarge ? new Problem('payload-too-large', 'The limit is 32 kB.') : new Problem('validation', 'The body is not valid JSON.', { errors: [{ location: 'body', message: 'invalid JSON' }] }));
        });
      });
    }
    const input = spec.validateRequest(op, { path: match.path, query: new URL(req.url, 'http://x').searchParams, headers: req.headers, body: req.body as unknown, isJson: !!req.is('application/json') });
    await handlers[op.id]!({ p: principal!, input, req, res });
  });

  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const problem = err instanceof Problem ? err : new Problem('internal', 'Something went wrong. Quote the correlation id.');
    if (!(err instanceof Problem)) log.error({ err }, 'unhandled');
    if (res.headersSent) { res.destroy(); return; }
    res.locals.problem = problem.type;
    res.status(problem.status).set(problem.headers).type('application/problem+json')
      .send(JSON.stringify(problem.toProblem(req.path, res.locals.correlationId as string)));
  });

  return { app, db, spec, audit, webhooks, domain, upstreams };
}
