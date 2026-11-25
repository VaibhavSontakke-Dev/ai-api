# Security and governance

## Identity flow

```
user signs in ──> copilot token (audience support-copilot)
                     │  MCP server exchanges it (RFC 8693, client credentials)
                     ▼
               API token: sub = user, act = agent, scopes = user ∩ agent, 5 minutes
                     │
                     ▼
               API checks scope, account, field, agent policy
```

- The API refuses the copilot token, so the MCP server cannot pass it through or use it to approve.
- The MCP server has no rights of its own. Without a user token it can do nothing.
- Exchange refuses an agent token as subject, so delegation cannot be chained.
- Approval needs an interactive token without `act`, which the agent never holds.

## Threats and controls

| Threat | Control | Evidence |
|---|---|---|
| Agent acts beyond the user | Scope intersection at exchange; checks in the API | B1 to B4 |
| Agent writes on its own | Every agent write is a proposal (202). Approve and reject refuse `act` tokens. | C1, contract tests |
| Prompt injection in case text | Structural: no write without a person, no ARR, no bulk tool. Then: text marked untrusted, invisible characters removed, suspicious text withheld and counted in the audit trail. | D1, D2, D5 to D7, D9 |
| Data leaves through a comment | Comments need approval; the console shows the exact text, escaped | C1 |
| ARR leak | Needs `customers:arr:read`, and is never sent to an agent. Errors, logs, audit and webhooks do not contain it. | D3, contract tests |
| Contact data to a model provider | Emails, phones, cards, IP addresses and secrets redacted in the API for agents | D4 |
| Reading other accounts | `accounts` claim on reads, lists, writes and approvals; same 404 as missing | B3 |
| ARR of the wrong customer | Reviewed crosswalk, quarantine | Contract tests |
| Stale or repeated action | ETag, idempotency, version checked again at approval, 30-minute expiry, decided once | Contract tests |
| Runaway agent | Per-agent and user buckets (60 calls, 10 writes a minute), per-session limits in MCP, kill switch at the IdP and in the API | B6, C5, E1 |
| Unaccounted access | Every request and tool call is audited. Writes do not start, and results are withheld, if the MCP audit call fails. | E2 to E4 |
| Audit tampering | Append-only triggers and a hash chain; new rows checked on each read, the whole trail every 10 minutes | Unit and regression tests |
| Leaked webhook secret | Rotation with a 24-hour overlap; delete the subscription if it must end at once | Regression test |
| Dodging limits with a fake address | `X-Forwarded-For` is ignored unless `TRUST_PROXY` names the hops or proxies; `true` is refused | Regression tests |
| Forged webhook | HMAC over id, timestamp and body; constant time; 5-minute window; dedupe on id | Unit test |
| SSRF through webhooks | https only, public addresses only, checked at subscribe and at send, no redirects, no credentials in URLs | Unit test |
| Forged tokens | RS256 only, issuer, audience, type and expiry checked | Contract tests |
| Hostile upstream data | XML entities are not expanded; all upstream data validated; SQL uses bind variables | |
| Secrets | Webhook secrets encrypted with AES-256-GCM and shown once; production start fails on development defaults | Unit test |
| Browser | Tokens in httpOnly, SameSite=Strict cookies and never in the page; all writes are server actions; sign-out revokes the refresh token | Browser tests |

## Data handling

| Data | Class | Where it may go |
|---|---|---|
| ARR | Restricted | Finance users only |
| Comments, subjects | Confidential, untrusted | Users in account scope; agents redacted |
| Tier, renewal, usage | Internal | Users and agents in account scope |
| Audit trail | Restricted | `audit:read`; holds ids and hashes, no free text |

Responses carry `Cache-Control: no-store`. Tool arguments are stored as SHA-256 only. A hash of a short, guessable value can be found by trying; that is accepted.

## Known limits

- **The injection detector is a pattern list.** A paraphrase passes (eval D7). It must not be relied on; the approval step is the control.
- **A person can approve something bad.** The console shows what will be written, but approval fatigue is real. Watch approval rates and times.
- **Redaction misses things**, such as names and unusual phone formats.
- **Snapshots on disk contain ARR** in clear text when `DB_PATH` is a file. Use disk encryption.
- **Truncating the newest audit rows is noticed only while the process runs.** After a restart it is not. Anchor the last hash outside, for example in object storage with a retention lock.
- **HTTP reads are audited after the answer is sent**; if that insert fails, it is only logged. Writes are audited in the same transaction that completes them, and approvals the same way.
- **DNS can change between the webhook check and the connection.** An egress proxy closes this.
- **Rate limits are per process.**
- **Refresh tokens are not rotated.** The console is a confidential client and refreshes from parallel requests. They live 8 hours, are revoked at sign-out, work only with the console secret, and are never given to the copilot. An access token already issued stays valid until it ends, at most one hour.
- **The same person may approve what their own copilot proposed.** That is intended: it is confirmation, not four-eyes. Require `approvals:manage` from someone else if you need that.
- **The mock IdP signs anyone in.** It listens on loopback and must never be deployed, and neither must the demo sign-in in `../ai-app`.

## Governance

Kill switch: `DISABLED_AGENTS`, plus the IdP. New agents get an entry with their own maximum scopes in the IdP. Scopes, tools and the detector change through review, and the evals must pass. Data quality quarantine shows up in the audit trail under `kind=data_quality`.
