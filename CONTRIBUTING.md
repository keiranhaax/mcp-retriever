# Contributing

Keep changes focused and preserve the fork's MCP and provider
contracts. [AGENTS.md](AGENTS.md) owns project invariants and working
boundaries; this guide owns contributor commands and validation.

## Setup and dependency safety

Use Node.js 22 or newer and Corepack with the `packageManager` version
in `package.json`. CI covers Node 22 and 24. Do not install a global
pnpm or replace the pinned lockfile with npm output.

Prepare dependencies only in an isolated checkout with installation
approved on the production host. Use an empty private store and copy
imports to avoid shared hardlink mutations:

```bash
corepack pnpm install --frozen-lockfile --store-dir /path/to/private-store --package-import-method=copy
```

Replace the example path with the approved private store. Keep that
store explicit on subsequent commands, for example:

```bash
corepack pnpm --store-dir /path/to/private-store run check
```

Worktree isolation does not protect a shared store. `pnpm run` and
`pnpm exec` can trigger installation when dependency state differs.
For read-only diagnostics, invoke already-installed local binaries
directly; report missing prerequisites rather than installing them. Do
not force module-directory replacement or repair a shared cache.
Dependency patches belong in `patches/`, with matching
`pnpm-workspace.yaml` declarations and lockfile hashes. Changes there
need reproducibility checks using a fresh frozen install.

## Implementation conventions

- Use `http_json` in `src/common/http.ts` for provider JSON requests.
  Preserve response-size bounds, typed errors, and cancellation.
- Read keys, base URLs, and timeouts from `src/config/env.ts` and
  validate configured keys. Missing keys leave only that provider
  unavailable.
- Preserve caller cancellation and overall deadlines. Apply shared
  retries only to operations safe to retry within their total budget.
  Never automatically retry paid job creation without an explicit
  safety contract.
- Keep provider-specific schemas and defensive response validation.
  Use neutral fixtures for shared error/health tests.
- Follow existing TypeScript, ESM, Valibot, and Vitest patterns. Vite+
  owns formatting, lint, types, tests, and build. Formatting comes
  from `vite.config.ts`: tabs, single quotes, width 70, trailing
  commas.
- `format` and `check:fix` both run `vp check --fix`, which may change
  more than formatting. Use fixes only on approved files and inspect
  the diff. `check` is non-fixing; there is no `format:check` script.
- For bugs or public-contract changes, reproduce the failure with a
  focused regression before changing behavior. Keep unrelated
  refactors, dependencies, logging, and generated files out of scope.

## Verification by change type

**Documentation only:** check changed Markdown formatting, local
links, referenced paths and commands, instruction consistency, and
`git diff --check`. Use the existing formatter without installation:

```bash
./node_modules/.bin/vp fmt --check AGENTS.md CONTRIBUTING.md
```

Replace the example paths with the changed Markdown files. No build,
provider call, or new runtime test is needed for prose-only changes.
Executable examples need appropriate safe validation. CI still runs
its configured gates when triggered.

**Code or public contract:** start with affected regression tests:

```bash
./node_modules/.bin/vitest run src/path/to/changed.test.ts
```

Replace that example with the actual test path. Before handing off an
integration candidate, run the repository gate with the same approved
dependency/store setup. With the example private store above:

```bash
corepack pnpm --store-dir /path/to/private-store run check
corepack pnpm --store-dir /path/to/private-store test
corepack pnpm --store-dir /path/to/private-store run build
corepack pnpm --store-dir /path/to/private-store run test:smoke
```

The offline smoke script uses fixture credentials, temporary
home/result storage, unused loopback ports, and blocked provider
fetches. It covers both protocol eras and client-visible transport
contracts, not live-provider availability. For transport/deployment
changes, consult [the runbook](docs/deployment.md) for staging and
production-preservation checks.

**Shell:** preserve executable modes and run ShellCheck on changed
shell launchers, for example `shellcheck start-server.sh`.

**Docker, only when explicitly in scope:** the selected deployment is
native Node/PM2; Docker is not a native-path validation gate. For
separately authorized Docker work, existing launcher/config checks
are:

```bash
python3 -B -m unittest discover -s docker -p 'test_*.py' -v
docker build --check .
```

These do not prove image or MCPO runtime behavior; Docker changes also
need authorized isolated image/runtime validation. Report unavailable
checks without starting a daemon or installing prerequisites.

After required checks pass, repeat or broaden only for new edits,
failures, or unresolved concerns. Separate existing failures and
historical evidence from fresh checks. Finish with `git diff --check`
and review the complete diff, including new files.

## Documentation ownership and submission

README owns public purpose, capabilities, setup, and navigation.
Deployment docs own operational procedures; ADRs own rationale; dated
verification and audit records own historical evidence. Keep proposed
work labeled as proposed. Update the relevant authoritative reference
when behavior changes, and link rather than duplicate it.
[The handoff](docs/agent-handoff.md) records separate unfinished docs.

A local task does not require an issue, PR, changeset, or version
bump. When submission is requested, follow existing commit style and
include rationale, scope, actual checks, and compatibility/operational
impact. Release/publish scripts and registry metadata updates belong
only to an explicitly requested release. Preserve upstream attribution
and keep discussion respectful.
