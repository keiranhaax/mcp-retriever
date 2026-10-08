# mcp-retriever

## 0.0.25

### Changes

- Record fork authorship: `keiranhaax` is the package author, Scott
  Spence is credited as the original author of `mcp-omnisearch`, and
  `LICENSE` carries both copyright lines.
- Point the npm homepage and the MCP registry `websiteUrl` at
  <https://keiranhaax.dev>, and move `server.json` to the `2025-12-11`
  registry schema.
- Correct the deployment runbook's fork metadata policy, which still
  described the fork as unpublished.

## 0.0.24

First release under the `mcp-retriever` name, published to npm and the
MCP registry on 2026-10-06. It includes the upstream `0.0.24` patch
changes listed at the end of this section plus the following.

### Changes

- Rename the project from `mcp-omnisearch` to `mcp-retriever`:
  `RETRIEVER_*` settings, `retriever://` resources, `_meta.retriever`,
  the `~/.cache/mcp-retriever/results` store, and the `/retriever`
  Docker/MCPO path. The README's "License and origins" section lists
  the renames to apply when upgrading.
- Add `setup` and `keys` commands that store provider keys in a
  private `~/.config/mcp-retriever/credentials.env` file and write or
  print client configuration.
- Bundle the patched runtime dependencies so npm installs match the
  tested dependency tree.
- Remove all Kagi integrations and configuration.
- Replace URL summarization with Firecrawl v2 `summary` format.
- Add authenticated remote pagination for oversized results.
- Harden retries, URL validation, provider timeouts, schemas, runtime
  startup, and remote proxy deployment.
- Refresh provider contracts: advertise Exa `publication`, tolerate
  Brave no-result and mixed-row response shapes, normalize Tavily date
  and country filters, and support current Exa and Firecrawl response
  shapes, crawl parameters, and terminal statuses.
- Runtime-validate retained upstream search, AI/GitHub, processing,
  and shared Firecrawl response envelopes with secret-safe
  malformed-response errors; deterministic schema failures are not
  retried.
- Record upstream provider classifications, runtime-validation
  coverage, and excluded provider surfaces in
  `docs/provider-synchronization.md`.
- Serve MCP `2026-07-28` through project-local pinned
  `mcp-proxy@6.7.3` while keeping stateless legacy `2025-11-25`
  compatibility; retire the legacy `/sse` endpoint in favor of `/mcp`.
- Add a narrow HTTP security guard (`src/server/http_guard.ts`) that
  owns the public socket: Host and Origin allowlists with clean
  userinfo rejection, route limiting to `POST /mcp` and `GET /ping`, a
  4 MB pre-dispatch body bound, and rejection of modern envelopes
  missing the `MCP-Protocol-Version` header (SDK issue `#2589`).
- Record the Path A architecture decision and staging evidence in
  `docs/architecture-decision-mcp-2026-07-28.md` and the operations
  runbook in `docs/deployment.md`.

### Upstream 0.0.24 patch changes

- bb2f1c5: Add Tavily search operator support: map
  site/date/exact/location operators to native API parameters.
- 6db2d23: Add comprehensive Vitest coverage for shared utilities and
  document tooling with Vite+ and Vitest badges.

## 0.0.23

### Patch Changes

- a49aae8: Migrate build toolchain from tsc/prettier to vite-plus; add
  CI workflow, CLAUDE.md, and VSCode settings

## 0.0.22

### Patch Changes

- 8383048: fix: update Exa, Firecrawl v2, and Tavily APIs to match
  current specs
- 91f2889: fix: update tsconfig for TypeScript 6 and fix Octokit type
  compatibility

## 0.0.21

### Patch Changes

- a9b7c3c: Add Linkup.so as ai_search provider with sourced answer
  support
- 9de2d09: feat: consolidate to 4 tools, remove Perplexity/Jina, split
  utils, add tool annotations

## 0.0.20

### Patch Changes

- 57d7b65: fix: use picklist instead of union literals for proper JSON
  Schema enum output

## 0.0.19

### Patch Changes

- 81573f7: Large results saved to tmp with section index for LLM file
  navigation

## 0.0.18

### Patch Changes

- 09e7fd7: Deduplicate Firecrawl providers with shared utility
  functions
- 2efd54e: Deduplicate query construction logic between Brave and Kagi
  providers
- 9145b10: Fix site: operator by removing parentheses in Brave and
  Kagi query construction
- be9a14d: Refactor: consolidate error handling and utilities
- 4746562: Refactor: standardize error handling

## 0.0.17

### Patch Changes

- 845649b: Enhanced Web Search with Provider-Specific Operators

## 0.0.16

### Patch Changes

- 732a8fd: Consolidate 20 MCP tools into 8

## 0.0.15

### Patch Changes

- correct mcp name

## 0.0.14

### Patch Changes

- d32dcf1: mcp registry setup

## 0.0.13

### Patch Changes

- 0c1d3da: swap mcp/sdk with tmcp

## 0.0.12

### Patch Changes

- 047898a: Refactor Kagi enrichment and Firecrawl providers to
  http_json with timeouts
- 3b529b0: Refactor three providers to http_json; unify auth and error
  handling, config and run prettier
- 8d7fd35: fix exa features
- efa419e: Refactor Perplexity, Kagi FastGPT, Jina providers to
  http_json

## 0.0.11

### Patch Changes

- df090fc: add exa.ai features
- 8b18293: remove exa research feature

## 0.0.10

### Patch Changes

- 9bab891: doesn't break if no GitHub key added

## 0.0.9

### Patch Changes

- 8002c78: feat: add GitHub search provider integration
  - Updated package.json and pnpm-lock.yaml to include Octokit for
    GitHub API interactions.
  - Enhanced SearchResult interface to include optional metadata
    field.
  - Added GITHUB_API_KEY to environment configuration.
  - Implemented GitHubSearchProvider class for searching code,
    repositories, and users on GitHub.
  - Registered GitHub-specific search tools in the tool registry with
    custom handling for search requests.

## 0.0.8

### Patch Changes

- 50ac221: added firecrawl shelf host env variable

## 0.0.7

### Patch Changes

- 95e671f: update documentation

## 0.0.6

### Patch Changes

- feat: add Docker support with MCPO integration for cloud deployment

## 0.0.5

### Patch Changes

- 295f28b: Add search operator support and update provider
  descriptions

## 0.0.4

### Patch Changes

- add firecrawl feature

## 0.0.3

### Patch Changes

- 0d937fa: Add Tavily Extract Provider for web content extraction

## 0.0.2

### Patch Changes

- ability to use individual API keys

## 0.0.1

### Patch Changes

- initial release
