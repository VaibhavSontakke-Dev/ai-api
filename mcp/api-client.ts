/** Calls the API with a token obtained by exchange. The MCP server has no identity or rights of its own. */
export type Session = {
  apiUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  /** The signed-in user's copilot-audience token. The API refuses it, so it cannot be used directly. */
  userToken: string;
};

export class ApiError extends Error {
  readonly status: number;
  readonly problem: { type?: string; detail?: string; rule?: string; requiredScope?: string; source?: string; errors?: { location: string; message: string }[] };
  readonly retryAfter: number | null;
  constructor(status: number, problem: ApiError['problem'], retryAfter: number | null) {
    super(problem.detail ?? `HTTP ${status}`);
    this.status = status;
    this.problem = problem;
    this.retryAfter = retryAfter;
  }
  get code(): string { return this.problem.type?.split('/').pop() ?? `http-${this.status}`; }
}

export class ApiClient {
  private readonly s: Session;
  private token: { value: string; expiresAt: number; scopes: Set<string> } | null = null;

  constructor(session: Session) { this.s = session; }

  /** Short-lived, narrowed to agent scopes, carries `act`. Refreshed by a new exchange, never by a stored secret. */
  private async exchange(): Promise<{ value: string; scopes: Set<string> }> {
    if (this.token && this.token.expiresAt > Date.now() + 15_000) return this.token;
    const res = await fetch(this.s.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      signal: AbortSignal.timeout(5000),
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange', client_id: this.s.clientId, client_secret: this.s.clientSecret,
        subject_token: this.s.userToken, subject_token_type: 'urn:ietf:params:oauth:token-type:access_token', audience: 'entitlement-api',
      }),
    });
    const body = await res.json() as { access_token?: string; expires_in?: number; scope?: string; error?: string };
    if (!res.ok || !body.access_token) {
      throw new ApiError(401, { type: 'x/sign-in-required', detail: body.error === 'access_denied' ? 'This agent has been disabled by an administrator.' : 'The user session has ended. Ask the user to sign in again.' }, null);
    }
    this.token = { value: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 60) * 1000, scopes: new Set((body.scope ?? '').split(' ')) };
    return this.token;
  }

  async scopes(): Promise<Set<string>> { return (await this.exchange()).scopes; }

  async call(method: 'GET' | 'POST', path: string, o: { body?: unknown; headers?: Record<string, string>; correlationId: string }): Promise<{ status: number; body: any }> {
    const { value } = await this.exchange();
    const res = await fetch(`${this.s.apiUrl}${path}`, {
      method, redirect: 'error', signal: AbortSignal.timeout(20_000),
      headers: { authorization: `Bearer ${value}`, 'x-correlation-id': o.correlationId, ...(o.body !== undefined && { 'content-type': 'application/json' }), ...o.headers },
      ...(o.body !== undefined && { body: JSON.stringify(o.body) }),
    });
    const text = await res.text();
    let body: any = null;
    try { body = text ? JSON.parse(text) : null; } catch { /* handled as an error below */ }
    if (!res.ok || body === null) throw new ApiError(res.status, body ?? {}, Number(res.headers.get('retry-after')) || null);
    return { status: res.status, body };
  }
}
