/**
 * Mock OAuth 2.0 authorization server. Keys are generated at start-up and never written to disk.
 *
 *   POST /dev/login  Stands in for the interactive login. Issues a user token for one audience.
 *   POST /token      token-exchange (RFC 8693) for agents, refresh_token for the console
 *   POST /revoke     Ends a console session
 *
 * A user logs in either to the API (`entitlement-api`, interactive) or to the copilot (`support-copilot`).
 * The API rejects copilot-audience tokens, so the MCP server cannot forward the user's token. It must exchange it,
 * and the exchange always adds `act` and narrows scopes. An agent therefore never holds a token that can approve.
 */
import express from 'express';
import { exportJWK, generateKeyPair, SignJWT, jwtVerify } from 'jose';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

export const API_AUDIENCE = 'entitlement-api';
export const COPILOT_AUDIENCE = 'support-copilot';
const EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange';

type User = { scopes: string[]; accounts: string[] | '*'; role: string };
const SUPPORT = ['customers:read', 'cases:read', 'cases:comment', 'cases:escalate'];
export const USERS: Record<string, User> = {
  'sam.support': { role: 'Support engineer', scopes: SUPPORT, accounts: '*' },
  'lena.lead': { role: 'Support lead', scopes: [...SUPPORT, 'approvals:manage', 'audit:read', 'webhooks:manage'], accounts: '*' },
  'fiona.finance': { role: 'Finance analyst', scopes: ['customers:read', 'customers:arr:read', 'cases:read'], accounts: '*' },
  'carl.csm': { role: 'Customer success, two accounts', scopes: ['customers:read', 'cases:read', 'cases:comment'], accounts: ['ACC-007', 'ACC-012'] },
};
/** The most an agent can ever receive, whoever it acts for. ARR, approvals, audit and webhooks are never included. */
export const AGENT_SCOPES: Record<string, string[]> = { 'support-copilot-mcp': SUPPORT };

export async function createMockIdp(opts: { issuer: string; agentSecret: string; consoleSecret?: string; accessTtlSeconds?: number; disabledAgents?: Set<string> }) {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'dev-1', alg: 'RS256', use: 'sig' };
  const accessTtl = opts.accessTtlSeconds ?? 3600;
  // Not rotated: the console is a confidential client and refreshes from parallel requests. Absolute lifetime 8 h.
  const sessions = new Map<string, { user: string; expiresAt: number }>();
  const secrets: Record<string, string> = { 'support-copilot-mcp': opts.agentSecret, console: opts.consoleSecret ?? 'local-console-secret' };
  const clientOk = (id: string | undefined, secret: string | undefined): boolean => {
    if (!id || !Object.hasOwn(secrets, id)) return false;
    const [given, want] = [Buffer.from(secret ?? ''), Buffer.from(secrets[id]!)];
    return given.length === want.length && timingSafeEqual(given, want);
  };
  const disabled = opts.disabledAgents ?? new Set<string>();

  const sign = (claims: Record<string, unknown>, sub: string, aud: string, ttlSeconds: number): Promise<string> =>
    new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'dev-1', typ: 'at+jwt' })
      .setIssuer(opts.issuer).setSubject(sub).setAudience(aud).setIssuedAt().setJti(randomUUID())
      .setExpirationTime(Math.floor(Date.now() / 1000) + ttlSeconds).sign(privateKey);

  const userToken = (name: string, aud: string = API_AUDIENCE, ttl = accessTtl): Promise<string> => {
    const u = USERS[name];
    if (!u) throw new Error(`unknown user ${name}`);
    return sign({ scope: u.scopes.join(' '), accounts: u.accounts, azp: aud === API_AUDIENCE ? 'console' : 'copilot-ui' }, name, aud, ttl);
  };

  const app = express();
  app.use(express.json(), express.urlencoded({ extended: false }));
  app.get('/.well-known/jwks.json', (_req, res) => { res.json({ keys: [jwk] }); });

  app.post('/dev/login', async (req, res) => {
    const { user, audience = API_AUDIENCE } = (req.body ?? {}) as { user?: string; audience?: string };
    if (!user || !Object.hasOwn(USERS, user) || ![API_AUDIENCE, COPILOT_AUDIENCE].includes(audience)) {
      res.status(400).json({ error: 'invalid_request' }); return;
    }
    let refresh: { refresh_token: string } | undefined;
    if (audience === API_AUDIENCE) { // never for the copilot
      refresh = { refresh_token: randomBytes(32).toString('base64url') };
      sessions.set(refresh.refresh_token, { user, expiresAt: Date.now() + 8 * 3_600_000 });
    }
    res.json({ access_token: await userToken(user, audience), token_type: 'Bearer', expires_in: accessTtl, ...refresh });
  });

  app.post('/token', async (req, res) => {
    const b = (req.body ?? {}) as Record<string, string | undefined>;
    if (!clientOk(b.client_id, b.client_secret)) { res.status(401).json({ error: 'invalid_client' }); return; }
    if (b.client_id === 'console') {
      if (b.grant_type !== 'refresh_token') { res.status(400).json({ error: 'unsupported_grant_type' }); return; }
      const session = sessions.get(b.refresh_token ?? '');
      if (!session || session.expiresAt <= Date.now()) { res.status(400).json({ error: 'invalid_grant' }); return; }
      res.json({ access_token: await userToken(session.user), token_type: 'Bearer', expires_in: accessTtl });
      return;
    }
    if (disabled.has(b.client_id!)) { res.status(403).json({ error: 'access_denied' }); return; }
    if (b.grant_type !== EXCHANGE) { res.status(400).json({ error: 'unsupported_grant_type' }); return; }
    const allowed = AGENT_SCOPES[b.client_id!]!;
    if (b.audience !== API_AUDIENCE) { res.status(400).json({ error: 'invalid_target' }); return; }
    try {
      const { payload } = await jwtVerify(b.subject_token ?? '', publicKey, { issuer: opts.issuer, audience: COPILOT_AUDIENCE });
      if (payload.act) throw new Error('delegation chains are not allowed');
      const userScopes = String(payload.scope ?? '').split(' ');
      const requested = b.scope ? b.scope.split(' ') : allowed;
      const granted = requested.filter((s) => allowed.includes(s) && userScopes.includes(s));
      if (granted.length === 0) { res.status(400).json({ error: 'invalid_scope' }); return; }
      const ttl = Math.min(300, Number(payload.exp) - Math.floor(Date.now() / 1000));
      const access_token = await sign(
        { scope: granted.join(' '), accounts: payload.accounts, azp: b.client_id, act: { sub: `agent:${b.client_id}` } },
        String(payload.sub), API_AUDIENCE, ttl);
      res.json({ access_token, issued_token_type: 'urn:ietf:params:oauth:token-type:access_token', token_type: 'Bearer', expires_in: ttl, scope: granted.join(' ') });
    } catch {
      res.status(400).json({ error: 'invalid_grant' });
    }
  });

  app.post('/revoke', (req, res) => {
    const b = (req.body ?? {}) as Record<string, string | undefined>;
    if (b.client_id !== 'console' || !clientOk(b.client_id, b.client_secret)) { res.status(401).json({ error: 'invalid_client' }); return; }
    sessions.delete(b.token ?? '');
    res.status(200).json({});
  });

  return { app, sign, userToken, disabled };
}
