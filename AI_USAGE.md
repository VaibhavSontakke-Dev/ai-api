# AI usage

## What was used

Claude Code (Claude Opus 5.5) wrote nearly all of the code, tests and documents in this repository and in `../ai-app`, in one session, from the assignment PDF. The candidate chose the scope: the prompt also described a procure-to-pay product, the model asked which one to build, and the answer was this assignment.

## What it got wrong

| Mistake | How it was found | Fix |
|---|---|---|
| A second approver could mark an approval `stale` after the first had already written upstream; webhook and audit record were lost | Reading the code after 89 of 90 tests passed. No test covered it. | Failing test first, then each call may only end the state it owns |
| The demo clock ticks, so a fixture set to "exactly 48 h" moved over the boundary two seconds after start | First manual run gave five cases instead of four | Fixture moved; the boundary is tested with a fixed clock |
| `search_cases` hid that two sources disagree about a renewal | Answering the sample question with the tool output | See TESTEVALS.md |
| MCP results were barely smaller than REST | Eval E6 | Columnar result |
| First idempotency design kept failed records, so a retry after a crash would fail its own checks | Review before the first run | `dispatched` mark; tests for both directions |
| A replayed proposal said "waiting" after it was rejected; the approvals list lost old requests; every audit page re-read the whole log; proxy addresses were ignored. None was in the documents. Case lists read everything, which was documented. | The model listed them when the candidate asked what was still missing; the candidate then asked for the fixes | 22 tests, 20 of which failed before the fixes |
| Two README commands did not work in Windows PowerShell | Same list; confirmed by running them | Replaced and run |
| Demo commands given to the candidate failed three times: PowerShell quoting through npm, PowerShell syntax for a Command Prompt window, and a Claude Desktop menu that was not there | The candidate ran them | Commands tested in the right shell; another client used |
| Wrong assertion about which approval expires first | Test failure | Test corrected |
| The console used `Date.now()` in a way Next.js 16 refuses while prerendering; the build passed | Server log during a browser check | `connection()` |
| `next start` listened on the network, exposing the demo sign-in | Same log | Bound to loopback |
| Added `newman` as a dependency, which brought a critical advisory | `npm audit` | Run on demand through npx |
| Contract lacked 413 and 500 | Writing the response checker | `default` response, accepted for those two only |

## How it was verified

- 145 automated tests of the API and MCP server; every API response checked against `openapi.yaml`.
- Failure injection: errors, hanging and flaky upstreams, lost answers, broken audit.
- OpenAPI lint, TypeScript strict mode, ESLint on the console, `npm audit` clean in both projects.
- 18 browser tests of the console against the real API, run three times in a row: forms, stale pages, roles, session renewal, contrast in light and dark mode, phone width.
- Postman collection run through newman.
- The full chain by hand in a browser: MCP proposal, approval in the console, webhook verified by the receiver.
- `npm ci` and `npm test` in a copy of the folder.

## Not verified

- Docker and Make: not installed on the build machine. The CI workflow covers them but has never run.
- A model through `npm run demo`: the candidate ran it with a key, and the API refused for lack of credit, so no model has answered through that script. The candidate then connected Google Antigravity to the MCP server, which answered the sample question (`mcp/transcripts/antigravity-session.md`). The tool call was checked against the audit trail.
- `mcp/transcripts/sample-session.md` was driven by the same model that wrote the fixtures, so it is not independent evidence. It shows the tools working, not that another model would choose well.

## Candidate's own review

_Drafted with Claude Code from what I did in the session._

**Decisions I made**

- One of my first prompts described a procure-to-pay product. I chose to build this assignment instead.
- I asked what was still missing after the first version, and had the gaps fixed.
- The Anthropic API refused my key for lack of credit and my Copilot credits had run out, so I connected Google Antigravity to the MCP server.

**What I ran and tested**

- I ran the API and the console on Windows and used the demo users.
- I added comments and escalated a case in the console, and compared that with what the AI may do.
- I went through the demo: the sample question, the withheld comment, approval, a failing source, the audit page and the tests.
- With Antigravity I asked the sample question, had a case summarised, had an escalation proposed, approved it in the console and asked for its status. I also asked about CS-10255, the case with the planted instruction; the audit trail shows it was flagged.
- I made a comment proposal for `carl.csm` through the MCP tools and approved it as `lena.lead`.
- I stopped the API and asked again in a new conversation. The AI said the service was unavailable and did not make up data.

**What I found or questioned**

- Demo commands I was given failed in my terminal. They were written for PowerShell and I use Command Prompt.
- `npm run demo` does not read `.env`, so it found no key.
- `carl.csm` could not see proposals made for `sam.support`. I asked why; it is intended.
- I asked who can approve, whether the AI can approve, what happens when the token expires, and whether Docker is needed.

**What I did not do**

- I did not run Docker, Make or the six model evals.
