/** Sample consumer. Verifies the signature on the raw bytes, then deduplicates on webhook-id. */
import express from 'express';
import { verify } from './signature.ts';

export function createReceiver(getSecret: () => string | null, onEvent: (event: unknown) => void) {
  const seen = new Set<string>();
  const app = express();
  app.post('/hooks', express.text({ type: 'application/json', limit: '64kb' }), (req, res) => {
    const secret = getSecret();
    const raw = typeof req.body === 'string' ? req.body : '';
    if (!secret || !verify(secret, req.headers, raw)) { res.status(401).end(); return; }
    const id = req.get('webhook-id')!;
    if (!seen.has(id)) {
      seen.add(id);
      onEvent(JSON.parse(raw));
    }
    res.status(204).end();
  });
  return app;
}
