# Decisions

## Assumptions

- "Open" means `open`, `in_progress` or `waiting_on_customer`.
- "More than 48 hours" is strict. "Renewal in the next 90 days" includes today and day 90, in UTC calendar days. A lapsed renewal does not count.
- The XML feed is newer than the CSV export, so it wins for tier and renewal. The CSV is the master for name, ARR and contract end.
- The appendix does not say whether comments are visible to customers. They are treated as if they were.

## Problems in the sample data

| Finding | Decision |
|---|---|
| The CSV says `ACC-77`; JSON, SQL and XML say `ACC-007` | A reviewed crosswalk table maps it. Padding would give `ACC-077`, which could be another company: the fixtures contain one, to prove ARR does not cross over. |
| An id that is neither canonical nor mapped | Quarantined, logged and audited. Never guessed. |
| `Status` and `Comments` next to `priority` | Normalised in the adapter. Records that fail validation are skipped and the list is marked `degraded`. |
| CSV and XML can disagree | The API picks one by rule and reports the conflict in `dataQuality`, also in lists and MCP results. |

## Design choices and trade-offs

| Choice | Why | Cost |
|---|---|---|
| Aggregate customers; keep cases as a collection with a small customer projection | Every consumer wants entitlement and usage together. Cross-system filters must run on the server to page correctly. | List calls depend on entitlement data |
| Entitlement is required, usage is optional | A customer without a tier is useless; one without usage is not | |
| A filter that needs a missing source is a 503 | A silently short list is worse than an error, above all for an agent | Less availability |
| Cursor is signed and bound to filters, sort and user | Stable paging, no tampering | Cursors end when the key rotates |
| Unknown query parameters are a 400 | `priorty=P1` would otherwise return everything | Stricter than usual |
| `Idempotency-Key` stores successes only | A failed attempt can be repeated with the same key | |
| The contract drives validation and scopes at run time | Contract and code cannot drift | About 150 lines of our own validator code |
| All agent writes need approval, comments too | Comments are the way data could leave. One mechanism is easier to reason about than risk tiers. | Friction. A lighter path for internal notes is the first thing to add. |
| Approval lives in the API, not in the MCP client | A client prompt can be skipped by a different client | A console is needed |
| Node with TypeScript run directly, `node:sqlite` | No build step and no native module, so one command runs it | `node:sqlite` is young; the SQL is plain enough to move to PostgreSQL |

### The hard part of idempotency

If the upstream applies a write and the answer is lost, a naive retry fails its own checks (the version has moved) or writes twice. Each record therefore stores an upstream key and a `dispatched` mark, set after the checks pass. A retry after an unknown outcome skips the checks and resends with the same upstream key. A definite refusal deletes the record, so a retry can never skip checks that failed. This depends on the case system honouring an idempotency key and an expected version; Salesforce would need an external-id upsert.

## Data model

SQLite holds only what the platform owns.

| Table | Purpose | Key and indexes |
|---|---|---|
| `idempotency_records` | Replay and crash safety | PK (caller, operation, key), no rowid; index on expiry for cleanup |
| `audit_log` | Append-only, hash chained | PK seq; (kind, seq) and (actor, seq) for the two ways it is read |
| `action_requests` | Human approval | (requested_by, status, created_at) for "mine"; (status, created_at) for the queue |
| `webhook_subscriptions` | Targets, encrypted secrets | PK id |
| `webhook_previous_secrets` | Old secret during the 24 h overlap | PK subscription |
| `webhook_deliveries` | Outbox | Unique (event, subscription); partial index on due pending rows |
| `account_aliases` | Identity crosswalk | PK (source, source_id) |
| `upstream_snapshots` | Last known good | PK key |

SQL rather than NoSQL because completing a write needs one transaction over idempotency, outbox and audit. In production: PostgreSQL, with `audit_log` partitioned by month.

## Resilience

Per attempt 1.5 s timeout, two retries with full jitter, one circuit breaker per source (opens after 5 failed calls, one probe after 10 s). Worst case for a hanging source is about 5 s, then the circuit opens. Reads fall back to a snapshot up to 24 h old and say so. Writes are retried only with an idempotency key.

## Case paging

The API sends the filters, the sort and the start position to the case system and stops reading once it has one record more than the page. For a list sorted by date or priority it reads about as many records as it returns, in pages of up to 50, whatever the total (a page of 20 out of 8,000 cases is tested to read at most 100). Records that fail validation make it read on. It relies on the upstream order, so it checks it: an answer out of order is a 503, not a page with missing cases. Filters are still applied again on our side.

This assumes the case system can filter by a list of accounts in a request body, and order by date and id. Salesforce can do this with SOQL, but a long account list has to be split, which then needs a merge.

## Audit verification

Checking the whole chain on each page load grows with the log. A page load now checks only new rows, and the last row checked before. The whole trail is checked at start and every 10 minutes in batches; the answer says when. An edit to an old row is therefore noticed within 10 minutes, not at once.

## MCP tools compared with REST

| | REST | MCP | Why |
|---|---|---|---|
| Unit | Resource | Task | `search_cases` answers the sample question in one call |
| Filter names | `openForMoreThanHours` | `open_for_more_than_hours`, `state: active` | Plain words; the three open statuses become one |
| Result | Nested objects | Columns and rows, 20 at most | A row per object was only 18% smaller than REST; columns took it past 40% (eval E6) |
| Free text | As is | `untrusted_*`, cut, withheld when it looks like an instruction | Injection |
| Errors | Problem JSON | Code plus a hint on what to do next | Stops blind retries |
| Concurrency | `If-Match` header | `case_version` argument | Models do not see headers |
| Idempotency | Caller's key | Derived from session, tool and arguments. A repeat shows the current state of the proposal; only one that expired, went stale or failed is proposed again. | Models repeat calls |
| ARR | Finance scope | Never | No agent need |
| Writes | Immediate | Proposal | Human in the loop |

There are two more tools than asked: `get_case` (a model needs the version and the context before proposing) and `check_action_request`. Tools the user has no scope for are not listed. There is no bulk tool and no approve tool.

## Stretch

Event-driven path: a transactional outbox with a local worker for `case.escalated`. In production the worker would publish to EventBridge or Kafka from the same table. Nothing here was deployed. Because the choice is asked for: the API fits a small container service (ECS Fargate or Cloud Run) with PostgreSQL; Lambda would work but circuit breakers and caches need shared state. For iPaaS, MuleSoft can import the OpenAPI file and subscribe to the webhook.

## Skipped, and how I would do it

| Skipped | Plan |
|---|---|
| Real OAuth login | Authorization code with PKCE at the corporate IdP; client credentials for iPaaS. `/dev/login` goes away. |
| Shared rate limits and circuit state | Redis. Today they are per process. |
| Several API instances | PostgreSQL; `FOR UPDATE SKIP LOCKED` for the outbox worker |
| Case projection | The list asks the case system for one ordered page (see below). Sorting by renewal is the weak spot: the case system does not know the date, so customers are taken 100 at a time in renewal order. With real volume: a projection fed by change events. |
| MCP over HTTP | stdio means one process per user. HTTP needs OAuth resource metadata and session handling. |
| MCP elicitation | Nice for the user, but the approval must stay in the API |
| Retention and erasure | Audit retention, snapshot purge, GDPR erasure by customer id |
| OpenTelemetry | Logs carry correlation ids across API, MCP and upstream calls; traces and metrics do not exist |
| Automatic model evals | The sample question, a summary, an escalation and a status check were run live in Google Antigravity. The six scenarios of `npm run demo -- --evals` did not run: the Anthropic account had no credit. See TESTEVALS.md. |

The Next.js console in `../ai-app` is extra. It exists because approval needs a place where a person decides.
