# Customer Entitlement & Support Case API

A governed API in front of a case system, an entitlement system and a usage warehouse, plus an MCP server so AI agents can use it safely. All upstream systems and the identity provider are local mocks. No real data or credentials are used.

| Repository | What |
|---|---|
| `ai-api` (this one) | The API, the MCP server, the tests and the documents: the whole assignment |
| `ai-app` | Extra: a web console. People use it to search cases and to approve what an AI proposes. |

The API works without the console. To use both, clone them next to each other, as `ai-api` and `ai-app`.

**To test by hand through the console or an LLM, follow the README of `ai-app`.**

## Run (about one minute)

Needs Node 24 or later. No database, Docker or cloud account.

```
npm ci
npm start
```

Wait for four "ready" lines and leave the terminal open.

Or `make run`, or `docker compose up`. The Makefile and the Docker files were **not run** on the build machine, which has neither tool; `npm start` was. The CI workflow runs both, and has not run yet either.

| Port | What |
|---|---|
| 4000 | API |
| 4100 | Mock identity provider |
| 4200 | Mock upstreams, with fault injection |
| 4300 | Sample webhook receiver |

Everything listens on loopback. The business clock starts at 2026-11-24T12:00Z so the fixture dates keep their meaning; change it with `DEMO_NOW`. Data lives in memory: **a restart resets everything and ends all logins and tokens.** Other settings are in `.env.example`; keep real keys in `.env`, which git ignores.

## Demo users

Made-up users, no passwords. An AI always acts for one of them and never gets more rights than that user.

| User | Role | Can |
|---|---|---|
| `sam.support` | Support engineer | Read, comment, escalate |
| `lena.lead` | Support lead | The same, plus approve for others, audit, webhooks |
| `fiona.finance` | Finance analyst | Read, including ARR; no writes |
| `carl.csm` | Customer success | Read and comment, two accounts only |

## Automated tests

| Command | What | Last result |
|---|---|---|
| `npm test` | Unit, contract, regression and behaviour tests, MCP evals | 145 passed |
| `npm run check` | Type check, OpenAPI lint, tests | passed; lint gives one warning about the localhost server URL |
| `npm run evals` | MCP evals only | 32 passed |
| `npm run postman` | Postman collection through newman (downloaded on demand); needs `npm start` | 40 requests, 70 assertions passed |
| `npm test` in `../ai-app` | Browser tests of the console against this API | 18 passed |

Every API response in the tests is validated against `openapi.yaml`, and the suite fails if an operation is never called. `npm test` uses its own ports, so it can run next to `npm start`. The Postman run resets the mock data.

## Try the API

With Postman: import `postman/collection.json` and `postman/environment.json`, choose the **Local** environment and run the folders in order.

From a terminal, the question of the assignment: which Platinum customers have P1 cases open for more than 48 hours and a renewal in the next 90 days?

PowerShell:

```powershell
$t = (Invoke-RestMethod http://localhost:4100/dev/login -Method Post -ContentType application/json -Body '{"user":"sam.support"}').access_token
(Invoke-RestMethod "http://localhost:4000/v1/cases?supportTier=Platinum&priority=P1&openForMoreThanHours=48&renewalWithinDays=90" -Headers @{Authorization="Bearer $t"}).data | Format-Table id, openHours
```

Any shell:

```
node -e "const j=(u,o)=>fetch(u,o).then(r=>r.json());j('http://localhost:4100/dev/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({user:'sam.support'})}).then(t=>j('http://localhost:4000/v1/cases?supportTier=Platinum&priority=P1&openForMoreThanHours=48&renewalWithinDays=90',{headers:{authorization:'Bearer '+t.access_token}})).then(r=>console.table(r.data.map(c=>({case:c.id,customer:c.customer.name,hours:c.openHours}))))"
```

Both show CS-10231, CS-10240, CS-10260 and CS-10275.

### Break a source

The API keeps answering and says what is missing. Any shell:

```
node -e "fetch('http://localhost:4200/__faults',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({target:'warehouse',mode:'error'})}).then(r=>r.json()).then(console.log)"
```

Targets: `cases`, `csv`, `xml`, `warehouse`. Modes: `off`, `error`, `hang`, `flaky`. Use `mode:'off'` to repair.

## Connect an LLM through MCP

```
LLM client --stdio--> mcp/server.ts --restricted token--> API --> mock systems
```

The client starts `mcp/server.ts` itself; only `npm start` has to be running. The user token cannot call the API: the MCP server exchanges it for an agent token of at most five minutes, with fewer rights. Comments and escalations become proposals that a person approves in the console.

**1. Get a token** for the user the AI acts for. Any shell:

```
node -e "fetch('http://localhost:4100/dev/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({user:'sam.support',audience:'support-copilot'})}).then(r=>r.json()).then(t=>console.log(t.access_token))"
```

It lasts one hour and ends when `npm start` restarts. For eight hours, set `ACCESS_TTL_SECONDS=28800` before `npm start`.

**2. Add the server** to the MCP settings of the client, with absolute paths (on Windows `"C:\\path\\to\\ai-api\\mcp\\server.ts"`):

```json
{
  "mcpServers": {
    "support-copilot": {
      "command": "node",
      "args": ["/absolute/path/to/ai-api/mcp/server.ts"],
      "env": {
        "COPILOT_USER_TOKEN": "the token from step 1",
        "API_URL": "http://localhost:4000",
        "TOKEN_URL": "http://localhost:4100/token"
      }
    }
  }
}
```

**3. Restart the client.** For `sam.support` it shows 6 tools: `search_cases`, `get_case`, `get_customer_summary`, `add_case_comment`, `escalate_case`, `check_action_request`.

Questions to ask and the expected answers are in the README of `ai-app`, section 3. The main one: *Use only the support-copilot tools. Which Platinum customers have P1 cases open for more than 48 hours and a renewal in the next 90 days?* Expect Acme Corp, Globex, Northwind Health and Wayne Logistics.

| Client | State |
|---|---|
| Google Antigravity | Used. Session: [mcp/transcripts/antigravity-session.md](mcp/transcripts/antigravity-session.md) |
| `npm run demo` (Anthropic API, paid, needs `ANTHROPIC_API_KEY`) | Reached the API, which refused for lack of account credit. `npm run demo` does not read `.env`; use `node --env-file=.env mcp/demo.ts`, and add `--evals` for the six model evals. |
| Other MCP clients | Not tried |

An earlier session, with a failure that was found and fixed, is in [mcp/transcripts/sample-session.md](mcp/transcripts/sample-session.md).

### Call the tools without an LLM

`npm run mcp` lists the tools. To call one:

| Shell | Command |
|---|---|
| Command Prompt | `node mcp/call.ts get_case "{\"case_id\":\"CS-10255\"}"` |
| PowerShell | `node --% mcp/call.ts get_case "{\"case_id\":\"CS-10255\"}"` |
| bash | `node mcp/call.ts get_case '{"case_id":"CS-10255"}'` |

Add `--user carl.csm` before the tool name to act for someone else.

## Layout

| Path | What |
|---|---|
| `openapi.yaml` | The contract. The server validates requests and takes required scopes from it. |
| `src/app.ts` | HTTP pipeline |
| `src/services/` | Business rules, idempotency, audit, rate limits, redaction |
| `src/upstream/` | Adapters, retries, circuit breakers |
| `src/webhooks/` | Outbox sender, signatures, sample receiver |
| `src/mocks/` | Upstreams, identity provider, fixtures |
| `src/tests/` | Unit, contract and regression tests |
| `mcp/` | MCP server, evals, demo, transcripts |
| `postman/` | Collection, environment and their generator |

Further reading: [DECISIONS.md](DECISIONS.md), [SECURITY.md](SECURITY.md), [TESTEVALS.md](TESTEVALS.md), [AI_USAGE.md](AI_USAGE.md).
