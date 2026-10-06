# Production deployment: MCP 2026-07-28 via pinned proxy (Path A)

This runbook describes the native guard/proxy topology and records
historical reliability-candidate verification. It is not proof of the
currently deployed revision. Recheck Git, generated artifacts, process
ownership, and endpoints separately before a cutover. See
[the agent handoff](agent-handoff.md) for documentation reconciliation
and [the transport ADR](architecture-decision-mcp-2026-07-28.md) for
historical architecture evidence.

The project was renamed from `mcp-omnisearch` to `mcp-retriever` in
October 2026: PM2 process `mcp-retriever` in `/opt/mcp-retriever`,
`RETRIEVER_*` environment variables, `retriever://` resources,
`_meta.retriever`, and the public `/retriever/` route. The launcher
refuses to start while any legacy `OMNISEARCH_*` variable is set.
Historical sections and linked evidence records keep the names in use
when they were written.

The selected deployment is native Node/PM2. Docker is outside this
path unless separately requested; historical Docker verification gaps
are not native-deployment blockers.

The candidate was exercised on Node.js 22.23.2 with Corepack pnpm
11.9.0. The table below describes the original deployment baseline.

## Versions

| Component                                 | Version  |
| ----------------------------------------- | -------- |
| Node.js                                   | v22.23.1 |
| pnpm (Corepack, repo `packageManager`)    | 11.9.0   |
| mcp-proxy (project-local, exact pin)      | 6.7.3    |
| `@modelcontextprotocol/*` (via mcp-proxy) | ^2.0.0   |
| Valibot                                   | ^1.4.2   |
| tmcp (stdio registration layer)           | ^1.19.4  |

The global `mcp-proxy@6.4.4` installation is deliberately left
untouched as the rollback runtime; production no longer executes it.

## Topology

```
client
  -> http_guard (100.84.79.102:8000)      # src/guard.ts, dist/guard.js
  -> mcp-proxy@6.7.3 (127.0.0.1:8002)     # loopback only, spawned child
  -> node dist/index.js (stdio)           # tmcp registration layer
```

PM2 manages exactly one foreground process (`start-server.sh` ->
`node ./dist/guard.js`); the guard spawns the proxy, which spawns the
stdio server, and signals propagate down the chain.

## Protocol support

- Modern `2026-07-28`: full envelope validation
  (`io.modelcontextprotocol/protocolVersion`,
  `io.modelcontextprotocol/clientInfo`, and
  `io.modelcontextprotocol/clientCapabilities` in `params._meta`),
  `MCP-Protocol-Version` and `Mcp-Method` headers required.
- Legacy `2025-11-25`: stateless streamable HTTP on `/mcp`, no session
  headers, no envelope required. This is what Hermes and the other
  local clients speak.
- `/sse` is retired (404). All known clients already use `/mcp`.

## Edge policy (enforced by the guard)

- `Host` allowlist: `100.84.79.102:8000` (direct Tailscale) and
  `mcp.keiranh.cloud` (via Caddy). Anything else: 403. Userinfo or
  malformed Host: 403 (never 500).
- `Origin`: validated against the same allowlist when present; absent
  Origin (non-browser clients) is allowed. No CORS headers are ever
  emitted.
- Routes: `POST /mcp` and `GET /ping` only. Everything else 404/405.
- Body: 4 MiB pre-dispatch bound (declared and chunked), 30 s intake
  deadline; the proxy enforces the same bound again downstream. Slow
  uploads receive 408 before their socket closes. `/ping` cannot carry
  a body. JSON-RPC batches are rejected before forwarding.
- Global bounds: 256 connections, 64 concurrent HTTP requests, and 600
  requests per 60-second window by default. These are shared
  instance-wide limits, not per-client quotas. Rate and concurrency
  rejection returns 429 with `Retry-After`; raw connection overflow
  closes excess sockets. Authentication failures and health requests
  also consume the global rate window.
- `#2589` guard: a modern envelope without `MCP-Protocol-Version` gets
  400 with JSON-RPC `-32020`; legacy no-envelope requests pass.
- The candidate authenticates `X-API-Key` in constant time in the
  guard before buffering MCP bodies, and again in the proxy. The
  launcher passes `MCP_API_KEY` to the proxy as `MCP_PROXY_API_KEY` in
  its environment, not on the command line. The existing Caddy
  Bearer-to-key translation is unchanged. Do not log either header.

## Ingress paths

- Direct Tailscale: `http://100.84.79.102:8000/mcp`
- Public: `https://mcp.keiranh.cloud/retriever/mcp` (Caddy
  `handle_path /retriever/*`, 4 MB `request_body`, Bearer translation,
  `flush_interval -1` for SSE)

## Configuration

`start-server.sh` sources `.env` in place and passes an explicit
allowlist of variables through `env -i`. Guard settings:

| Variable              | Default                              | Purpose                        |
| --------------------- | ------------------------------------ | ------------------------------ |
| `GUARD_LISTEN_HOST`   | `$BIND_HOST`                         | Public socket bind             |
| `GUARD_LISTEN_PORT`   | `$PORT`                              | Public socket port             |
| `GUARD_ALLOWED_HOSTS` | `$BIND_HOST:$PORT,mcp.keiranh.cloud` | Host/Origin allowlist          |
| `GUARD_UPSTREAM_PORT` | `8002`                               | Loopback proxy port            |
| `GUARD_PUBLIC_HOSTS`  | `mcp.keiranh.cloud`                  | TLS hostname(s) Caddy forwards |

The launcher fails closed on a wildcard `BIND_HOST` (the guard needs
an explicit address to build the allowlist).

The launcher also passes `RETRIEVER_CREDENTIALS_FILE=none` unless
`.env` sets that variable. The stdio server would otherwise fill unset
provider settings from the per-user file that `mcp-retriever setup`
writes (`~/.config/mcp-retriever/credentials.env`), which could enable
a provider the allowlist left out. Set it to a path only when this
deployment should read that file.

Candidate controls, all positive integers and passed through the
launcher allowlist:

- `GUARD_MAX_BODY_BYTES`: 4194304.
- `GUARD_BODY_READ_TIMEOUT_MS`: 30000.
- `GUARD_MAX_CONNECTIONS`: 256.
- `GUARD_MAX_INFLIGHT_REQUESTS`: 64.
- `GUARD_RATE_LIMIT_REQUESTS`: 600.
- `GUARD_RATE_LIMIT_WINDOW_MS`: 60000.

`pnpm-workspace.yaml` declares patches for `mcp-proxy@6.7.3`,
`@tmcp/transport-stdio@0.4.3`, and `tmcp@1.19.4`; their hashes and
package snapshots are locked. The proxy patch covers source and the
published runtime bundle. A fresh frozen install must pass the
transport tests, not rely on a previously edited `node_modules`.

Legacy HTTP disconnects do not mean explicit cancellation. A
`notifications/cancelled` request is routed only to an unambiguous
in-flight ID under the same API key. Concurrent ID collisions are
ignored rather than cancelling an arbitrary caller; a shared key is
one security principal, not per-client isolation. Custom-auth
stateless cancellation is intentionally not routed by this patch.
Modern subscriptions acquire upstream leases only after SDK validation
succeeds. Stdio forwards cancellation into provider requests.

## Verification commands

Run these in the isolated candidate worktree, never the live checkout:

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm run check
corepack pnpm test
corepack pnpm run build
corepack pnpm run test:smoke
python3 -B -m unittest discover -s docker -p 'test_*.py' -v
shellcheck start-server.sh
git diff --check
```

The smoke script starts and tears down its own loopback-only guard,
proxy, and stdio server using random unused ports, a temporary home
and result store, fixture credentials, and blocked provider fetches.
It checks ping, authentication, Host/Origin/routes, both protocol
eras, 14 tools with all fixture providers enabled, modern discovery,
resource-template reads, lossless UTF-8 pagination, envelope/header
mismatch rejection, batch rejection, and invalid-budget rejection. No
provider job is created. Real configured deployments may expose fewer
tools; fixture discovery is not a live-provider entitlement test.

The Docker launcher/Compose tests do not require a daemon. Image build
and real MCPO runtime checks are separate gates and remain unverified
when Docker is unavailable; do not start a system daemon just to make
this check pass:

```bash
docker build --check .
```

Read-only production health probes (not deployment authorization):

```bash
curl --max-time 10 -fsS http://100.84.79.102:8000/ping
curl --max-time 10 -fsS https://mcp.keiranh.cloud/retriever/ping
```

Before and after isolated checks, compare the exact PM2 process PID,
restart count, production source/build hashes, listeners, and result
file metadata. Never print raw `pm2 jlist`, environments, or
credential configuration. Capture only the relevant non-secret fields.

## Isolated verification snapshot (2026-09-06)

At the time of this verification, the reliability candidate was
uncommitted and **not deployed**. The results below are historical,
not a statement about the current checkout or running process.

- Fresh registry install into an empty private pnpm store: passed; all
  three dependency patches applied without manual edits.
- Final clean-copy frozen install, formatting, lint, and types:
  passed.
- Vitest: 477 tests passed across 46 files.
- Build and isolated MCP smoke: passed, 10 smoke groups.
- Docker launcher/Compose: 9 tests passed; ShellCheck and diff checks
  passed. `pnpm audit` reported zero advisories.
- Production guard PID 3153 and proxy PID 3189 remained unchanged,
  with zero PM2 restarts. Source/build hashes and metadata for the 12
  stored production results were unchanged across final verification.
  Direct and public `/ping` both returned `pong`.

At this initial snapshot, Docker image/runtime, Node.js 24, and live
provider behavior were unverified. Node 24 and selected live checks
were subsequently exercised in the separately approved follow-up
below. Docker still requires a daemon. No deployment, commits, or
pushes were performed.

`pnpm store status` reported modified cached dependencies. The shared
store was not repaired or purged. Verification used a separately
created private store with `--package-import-method=copy`; use the
same fresh-store isolation for release preparation rather than
trusting a pre-existing manually edited dependency tree.

## Node 24 and live-provider follow-up

The separately approved Node 24.20.0 check passed the frozen install,
lint/types, all 477 tests, build, and 10 offline MCP smoke groups.
Selected live-provider checks also ran against the isolated candidate.
See [Node 24 and live-provider evidence](verification-node24-live.md)
for exact coverage, cancellation-status caveats, skipped unbounded
operations, and incomplete final billing attribution. This follow-up
does not deploy the candidate or establish Docker runtime behavior.
Docker verification is relevant only if that deployment path is
separately requested.

## Cutover and rollback boundary

No cutover, restart, commit, or merge is included in isolated
verification. Before separately approved deployment, preserve and
verify the current launcher, frozen dependency tree, source/build
artifacts, and configuration privately; establish a restore point for
that actual release. Never overwrite a dirty production checkout.

The rollback below is the **historical 2026-08 protocol migration**,
not a current reliability-release rollback. Do not execute it blindly.

## Rollback

The release commit is `21dd09d` on
`feature/omnisearch-mcp-2026-07-28`; the pre-upgrade baseline is
`e33186d` (`keiran/production-fork-baseline-20260717`).

```bash
cd /opt/mcp-omnisearch
git checkout keiran/production-fork-baseline-20260717
corepack pnpm install --frozen-lockfile
corepack pnpm run build
pm2 restart mcp-omnisearch
```

The baseline launcher uses the global `mcp-proxy@6.4.4`, which was
never modified. If the global binary itself is ever damaged, offline
restore material lives in
`~/backups/mcp-proxy-6.4.4-rollback-20260815T020944Z/` (tarball with
verified sha512 integrity plus `ROLLBACK.md` with a rehearsed
restore).

## Fork metadata policy

This is a private fork deployed from git, not published to npm or the
MCP registry. `package.json` stays at `0.0.24` and `server.json` is
unchanged; version bumps and registry metadata only matter if the fork
is ever published upstream again.
