# Agent guidance: mcp-omnisearch

Repository-specific guidance for `keiranhaax/mcp-omnisearch`, a
maintained fork of `spences10/mcp-omnisearch`. This supplements
applicable host/user instructions; it does not override
higher-priority instructions or expand authorization. On this host,
shared approval and preservation policy lives in
`/home/ubuntu/AGENTS.md`.

## Working scope

`/opt/mcp-omnisearch` is a live deployment checkout. Develop and
validate changes in an approved isolated worktree under
`/home/ubuntu/worktrees/`. Preserve pre-existing edits and untracked
files, including `.hermes/`, `.env`, `package-lock.json`, and other
worktrees' unfinished documentation. Worktrees do not isolate shared
dependency stores.

After scope approval, complete implementation and appropriate checks
without repeated permission requests. Approval for code or docs does
not authorize dependency installation, credential changes, paid
provider calls, Git commits, publication or merges, deployment, or
service restarts unless those actions are included. Never weaken
security to make a client or test pass.

## Read only what the task needs

- [README](README.md): public capabilities and client usage.
- [Contributor guide](CONTRIBUTING.md): development commands,
  dependency isolation, conventions, and verification by change type.
- [Deployment runbook](docs/deployment.md): native guard/proxy
  topology, staging, and rollback. Read for transport/deployment work.
- [Transport ADR](docs/architecture-decision-mcp-2026-07-28.md):
  accepted architecture rationale and historical evidence.
- [Agent handoff](docs/agent-handoff.md): documentation reconciliation
  and separate unfinished work, not a live status report.
- `src/index.ts`, `src/server/handlers.ts`: stdio server and
  resources.
- `src/guard.ts`, `src/server/http_guard.ts`, `start-server.sh`: HTTP
  edge, proxy lifecycle, and startup allowlist.
- `src/server/tools/`, `src/providers/`, `src/config/env.ts`:
  registration, descriptions, schemas, dispatch, and provider config.
- `src/common/`: HTTP/errors, retries, validation, and result storage.

Inspect the affected source and tests, not an obligatory document
stack. Source, Git branches, generated `dist/`, and the running
process can differ. Branch names and historical checks do not prove
deployment. Recheck live state only when needed; distinguish source
behavior, observed deployment, historical evidence, and proposed work.

## MCP and provider invariants

- Preserve public tool names and modern `2026-07-28` plus legacy
  `2025-11-25` compatibility unless a breaking change is approved.
  `/mcp` is supported; `/sse` stays retired. Request-scoped SSE
  responses on Streamable HTTP remain valid.
- Preserve authentication, Host/Origin allowlists, route and envelope
  validation, body/resource bounds, deadlines, cancellation semantics,
  and loopback-only proxying. Stdout is protocol-only.
- Tool schemas, registration, transport, authentication, and error
  shapes are public contracts. Changed contracts need regression
  coverage, including client-visible discovery/schema checks where
  affected. Keep tool descriptions concise and useful for routing.
- Register providers only with valid configuration. Missing keys must
  not break unrelated tools. Keep schemas provider-aware and validate
  nullable or changing external response shapes defensively.
- Use shared HTTP/error/retry helpers and configured keys, base URLs,
  and timeouts. Preserve typed errors and provider-specific retry
  safety. See the contributor guide for implementation conventions.
- Keep result files private, bounded, expiring, and addressed through
  opaque IDs. Do not expose credentials, sensitive URLs, request
  payloads, or raw provider errors in results, logs, or health data.

## Completion

Use the contributor guide's checks for the change type. Fix failures
caused by the change and rerun affected checks; broaden only for new
changes, failures, or unresolved risk. Docs-only work needs document
validation, not a runtime build or paid calls. Runtime changes need
behavioral evidence, not static inspection alone.

Review the complete diff, including new files. Report changed paths,
actual checks, unavailable checks with reasons, and production impact.
A source edit, commit, merge, build, and deployment are separate
events. Update the relevant reference when a contract or handoff
changes; preserve dated evidence instead of rewriting it as current
fact.
