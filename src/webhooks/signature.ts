/** Standard Webhooks signing (https://www.standardwebhooks.com), plus AES-256-GCM for secrets at rest. */
import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const newSecret = (): string => `whsec_${randomBytes(32).toString('base64')}`;
const keyOf = (secret: string): Buffer => Buffer.from(secret.replace(/^whsec_/, ''), 'base64');

export function sign(secret: string, id: string, timestamp: number, body: string): string {
  return `v1,${createHmac('sha256', keyOf(secret)).update(`${id}.${timestamp}.${body}`).digest('base64')}`;
}

export function verify(secret: string, headers: Record<string, string | string[] | undefined>, body: string, nowSeconds = Math.floor(Date.now() / 1000), toleranceSeconds = 300): boolean {
  const [id, ts, sig] = ['webhook-id', 'webhook-timestamp', 'webhook-signature'].map((h) => headers[h]);
  if (typeof id !== 'string' || typeof ts !== 'string' || typeof sig !== 'string' || !/^\d+$/.test(ts)) return false;
  if (Math.abs(nowSeconds - Number(ts)) > toleranceSeconds) return false;
  const expected = Buffer.from(sign(secret, id, Number(ts), body));
  return sig.split(' ').some((s) => {
    const given = Buffer.from(s);
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

export function encrypt(key: Buffer, plain: string): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), data]);
}

export function decrypt(key: Buffer, blob: Uint8Array): string {
  const b = Buffer.from(blob);
  const d = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
}
