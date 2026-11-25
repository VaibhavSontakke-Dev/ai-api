/**
 * openapi.yaml is the single source of truth: the server validates requests with it, takes required scopes from it,
 * and the contract tests validate every response with it.
 */
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { Problem } from './problem.ts';

type Json = Record<string, any>;
type Param = { name: string; in: 'path' | 'query' | 'header'; required: boolean; isArray: boolean; schema: Json; validate: ValidateFunction };
export type Operation = {
  id: string; method: string; path: string; regex: RegExp; pathNames: string[]; params: Param[];
  body: ValidateFunction | null; bodyRequired: boolean;
  /** null: public. Empty: any valid token. */
  scopes: string[] | null;
  responses: Map<string, Map<string, ValidateFunction>>;
  /** From `deprecated: true` with x-deprecated-at, x-sunset and x-successor-version. */
  deprecation: { deprecatedAt: string; sunset: string; successor: string } | null;
};
export type ValidInput = { path: Record<string, string>; query: Record<string, any>; headers: Record<string, string> };
type RawInput = { path: Record<string, string>; query: URLSearchParams; headers: Record<string, string | string[] | undefined>; body: unknown; isJson: boolean };

const addFormats = addFormatsModule as unknown as (a: Ajv2020) => void;

const errorsOf = (location: string, v: ValidateFunction): { location: string; message: string }[] =>
  (v.errors ?? []).slice(0, 20).map((e) => ({
    location: `${location}${e.instancePath}`,
    message: e.keyword === 'additionalProperties' ? `unknown property ${e.params.additionalProperty}` : e.message ?? 'invalid',
  }));

const coerce = (raw: string, type: string | undefined): unknown => {
  if (type === 'integer' || type === 'number') return /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw;
  if (type === 'boolean') return raw === 'true' ? true : raw === 'false' ? false : raw;
  return raw;
};

export class Spec {
  readonly doc: Json;
  readonly operations: Operation[] = [];
  private readonly ajv: Ajv2020;

  constructor(file: URL = new URL('../openapi.yaml', import.meta.url)) {
    this.doc = parse(readFileSync(file, 'utf8')) as Json;
    this.ajv = new Ajv2020({ strict: false, allErrors: true });
    addFormats(this.ajv);
    this.ajv.addSchema({ $id: 'spec', components: { schemas: this.absolute(this.doc.components.schemas) } });
    for (const [path, item] of Object.entries<Json>(this.doc.paths)) {
      for (const [method, op] of Object.entries<Json>(item)) this.operations.push(this.compile(path, method, op));
    }
  }

  /** Point local refs at the registered document. */
  private absolute(node: any): any {
    if (Array.isArray(node)) return node.map((n) => this.absolute(n));
    if (!node || typeof node !== 'object') return node;
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, k === '$ref' && typeof v === 'string' ? `spec${v}` : this.absolute(v)]));
  }

  private deref(node: Json): Json {
    if (!node.$ref) return node;
    return (node.$ref as string).slice(2).split('/').reduce((o: any, k) => o[k], this.doc) as Json;
  }

  schema(name: string): ValidateFunction {
    return this.ajv.compile({ $ref: `spec#/components/schemas/${name}` });
  }

  private compile(path: string, method: string, op: Json): Operation {
    const pathNames: string[] = [];
    const regex = new RegExp(`^${path.replace(/\{(\w+)\}/g, (_m, n: string) => { pathNames.push(n); return '([^/]+)'; })}$`);
    const params: Param[] = (op.parameters ?? []).map((raw: Json) => {
      const p = this.deref(raw);
      const schema = this.deref(p.schema);
      return { name: p.name, in: p.in, required: !!p.required, schema, isArray: schema.type === 'array', validate: this.ajv.compile(this.absolute(p.schema)) };
    });
    const bodySchema = op.requestBody?.content?.['application/json']?.schema;
    const responses = new Map<string, Map<string, ValidateFunction>>();
    for (const [status, raw] of Object.entries<Json>(op.responses)) {
      const media = new Map<string, ValidateFunction>();
      for (const [type, m] of Object.entries<Json>(this.deref(raw).content ?? {})) media.set(type, this.ajv.compile(this.absolute(m.schema)));
      responses.set(status, media);
    }
    const oauth = (op.security as Json[]).find((s) => 'oauth' in s);
    return {
      id: op.operationId, method: method.toUpperCase(), path, regex, pathNames, params,
      body: bodySchema ? this.ajv.compile(this.absolute(bodySchema)) : null, bodyRequired: !!op.requestBody?.required,
      scopes: oauth ? (oauth.oauth as string[]) : null, responses,
      deprecation: op.deprecated ? { deprecatedAt: op['x-deprecated-at'], sunset: op['x-sunset'], successor: op['x-successor-version'] } : null,
    };
  }

  match(method: string, path: string): { op: Operation; path: Record<string, string> } | null {
    for (const op of this.operations) {
      const m = op.method === method ? op.regex.exec(path) : null;
      if (!m) continue;
      try {
        return { op, path: Object.fromEntries(op.pathNames.map((n, i) => [n, decodeURIComponent(m[i + 1]!)])) };
      } catch {
        return null; // malformed percent-encoding
      }
    }
    return null;
  }

  validateRequest(op: Operation, req: RawInput): ValidInput {
    const errors: { location: string; message: string }[] = [];
    const query: Record<string, any> = {};
    const headers: Record<string, string> = {};
    const known = new Set(op.params.filter((p) => p.in === 'query').map((p) => p.name));
    for (const name of new Set(req.query.keys())) {
      // A misspelt filter must not silently widen the result.
      if (!known.has(name)) errors.push({ location: `query.${name}`, message: 'unknown parameter' });
      else if (req.query.getAll(name).length > 1) errors.push({ location: `query.${name}`, message: 'separate values with commas instead of repeating the parameter' });
    }
    for (const p of op.params) {
      const rawHeader = req.headers[p.name.toLowerCase()];
      const raw = p.in === 'path' ? req.path[p.name]
        : p.in === 'query' ? req.query.get(p.name) ?? undefined
          : Array.isArray(rawHeader) ? rawHeader.join(', ') : rawHeader;
      if (raw === undefined) {
        if (p.required) errors.push({ location: `${p.in}.${p.name}`, message: 'is required' });
        else if (p.in === 'query' && p.schema.default !== undefined) query[p.name] = p.schema.default;
        continue;
      }
      const value = p.isArray ? raw.split(',') : coerce(raw, p.schema.type);
      if (!p.validate(value)) errors.push(...errorsOf(`${p.in}.${p.name}`, p.validate));
      else if (p.in === 'query') query[p.name] = value;
      else if (p.in === 'header') headers[p.name] = raw;
    }
    if (op.body) {
      if (!req.isJson || req.body === undefined) {
        if (op.bodyRequired) errors.push({ location: 'body', message: 'a JSON body is required' });
      } else if (!op.body(req.body)) errors.push(...errorsOf('body', op.body));
    }
    if (errors.length) throw new Problem('validation', 'One or more fields are not valid.', { errors });
    return { path: req.path, query, headers };
  }

  /** Returns contract violations; empty when the response is fine. */
  checkResponse(method: string, path: string, status: number, contentType: string | null, body: unknown): string[] {
    const m = this.match(method, path);
    if (!m) return [`no operation for ${method} ${path}`];
    // `default` covers only these two, so an undocumented status still fails the contract.
    const media = m.op.responses.get(String(status)) ?? ([413, 500].includes(status) ? m.op.responses.get('default') : undefined);
    if (!media) return [`${m.op.id}: status ${status} is not in the contract`];
    if (media.size === 0) return [];
    const validate = media.get((contentType ?? '').split(';')[0]!.trim());
    if (!validate) return [`${m.op.id} ${status}: content type ${contentType} is not in the contract`];
    return validate(body) ? [] : errorsOf(`${m.op.id} ${status}`, validate).map((e) => `${e.location} ${e.message}`);
  }
}
