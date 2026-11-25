const TITLES = {
  'validation': [400, 'Request is not valid'],
  'invalid-cursor': [400, 'Cursor is not valid for this query'],
  'unauthorized': [401, 'Authentication required'],
  'forbidden': [403, 'Missing permission'],
  'agent-not-allowed': [403, 'Agents may not do this'],
  'not-found': [404, 'Not found'],
  'escalation-rule': [409, 'Escalation rule not met'],
  'idempotency-in-progress': [409, 'A request with this key is in progress'],
  'already-decided': [409, 'Action request already decided'],
  'version-mismatch': [412, 'The case changed'],
  'payload-too-large': [413, 'Request body too large'],
  'idempotency-mismatch': [422, 'Idempotency key reused with a different request'],
  'target-not-allowed': [422, 'Webhook target not allowed'],
  'precondition-required': [428, 'If-Match is required'],
  'rate-limited': [429, 'Too many requests'],
  'internal': [500, 'Internal error'],
  'upstream-unavailable': [503, 'A required upstream is unavailable'],
} as const satisfies Record<string, readonly [number, string]>;

export type ProblemType = keyof typeof TITLES;

/** Thrown anywhere; turned into application/problem+json by the error handler. */
export class Problem extends Error {
  readonly type: ProblemType;
  readonly status: number;
  readonly title: string;
  readonly extra: Record<string, unknown>;
  readonly headers: Record<string, string>;

  constructor(type: ProblemType, detail?: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
    super(detail ?? TITLES[type][1]);
    this.type = type;
    [this.status, this.title] = TITLES[type];
    this.extra = extra;
    this.headers = headers;
  }

  toProblem(instance: string, correlationId: string): Record<string, unknown> {
    return {
      type: `https://errors.example.com/${this.type}`, title: this.title, status: this.status,
      detail: this.message, instance, correlationId, ...this.extra,
    };
  }
}
