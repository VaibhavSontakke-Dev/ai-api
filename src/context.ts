import { AsyncLocalStorage } from 'node:async_hooks';
import { pino } from 'pino';

/** The correlation id travels with the async call chain, so every log line and upstream call carries it. */
export const requestContext = new AsyncLocalStorage<{ correlationId: string }>();

// Logs go to stderr because stdout belongs to the protocol in the stdio MCP server.
export const log = pino(
  {
    level: process.env.LOG_LEVEL ?? (process.env.NODE_TEST_CONTEXT ? 'silent' : 'info'),
    base: { service: 'entitlement-api' },
    redact: {
      paths: ['authorization', '*.authorization', 'token', '*.token', 'secret', '*.secret', 'arrUsd', '*.arrUsd', 'body'],
      censor: '[redacted]',
    },
    mixin: () => ({ correlationId: requestContext.getStore()?.correlationId }),
  },
  pino.destination(2),
);

export type Clock = () => Date;
export const makeClock = (demoNow: string | null): Clock => {
  if (!demoNow) return () => new Date();
  // Starts at demoNow and keeps ticking, so expiry logic still works in a demo.
  const offset = Date.parse(demoNow) - Date.now();
  return () => new Date(Date.now() + offset);
};
