# Provider Synchronization Matrix

Audit date: 2026-08-14

Comparison points:

- local Task 1 baseline: `e33186d21d9fcf40b442a71423ba6bac2efac791`
- upstream v0.0.25 commit: `f374c1a57d5e9e0d909057306e6c76c93c5e5e44`
- pinned upstream v0.0.28 commit:
  `e636c7570010726348433d2531bd89b109e1d115`
- pinned audited upstream main:
  `e6fb269f9c59208b964a593cf8c2508e0efcdb00`

The fork diverged from upstream at
`daf9078ed0dd830491ff13b68113a2df5aece332`. Its fork-only commits are:

| Commit                                     | Fork-only purpose                                                                               |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `2a9d80b01c2cf0ac1d22ca021d04d58b29888b02` | Capture the production Omnisearch fork baseline and expanded provider/tool surface.             |
| `382991f84ba60ed7afc71110218b6ec221849cd8` | Refresh fork dependencies (already present at the Task 1 baseline; not changed here).           |
| `3ca94a976170d7d92f24c00fdedff69f5f7e807a` | Harden the remote runtime, validation, pagination, result storage, retries, and provider tests. |
| `5567c7b41e1a2d0f53351c23babe5a5c1af0a07f` | Remove Kagi and replace summarization with Firecrawl.                                           |
| `42c64dd6d565e96e1778b3e15785d6837e66970e` | Move remote results to a private user cache.                                                    |
| `401cbbf876f0ad49077766f36b6371f94af29a1d` | Make remote startup path-independent.                                                           |
| `37d523048c96f6312191ffdf8db0f5e96d68b12c` | Normalize remaining source formatting.                                                          |
| `4b48728ba505194a6b36e0151bd958d39e81c823` | Bound remote result storage.                                                                    |
| `e33186d21d9fcf40b442a71423ba6bac2efac791` | Allowlist the runtime environment.                                                              |

## v0.0.25 through v0.0.28

Each upstream functional change in the release changelogs that affects
providers, validation, retries, result delivery, MCP contracts, or
their tests is classified below. Dependency, package-manager,
version-bump, editor, and CI-only commits are handled separately after
the matrix.

This matrix records the provider surface at the synchronization audit.
The fork-only You search and You Research capabilities present then
were later retired and are not part of the current provider surface.

| Upstream change                                                                     | Classification         | Local evidence and decision                                                                                                                                                                                                                                                                |
| ----------------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Configurable large-result offload (`8678ebdd5bad07687852d00b38d3bfbccb1776d7`)      | conflicting            | The fork uses authenticated pagination plus a private, bounded, expiring result store. Preserve that remote contract rather than add upstream's global inline/file mode.                                                                                                                   |
| Shared provider tool plumbing (`49c70446db6c54b444c6082172bce1f99d73efcf`)          | conflicting            | The fork has an expanded provider catalog, local dispatch maps, runtime-health tracking, and different tool schemas. Replacing those with upstream's registry/response plumbing would change the fork's tool and status behavior.                                                          |
| Kebab-case source rename (`80469ef7d2fc9e2c62c6d1a6ff00e59ad5dda483`)               | intentionally rejected | Naming-only churn is not a provider contract fix; local underscore paths and imports remain stable.                                                                                                                                                                                        |
| Search-operator regression tests (`0a4517779c3274c0a0015fafd9d8b49bc3039e83`)       | already implemented    | The fork already has shared search-operator tests and provider-level request assertions, including Brave/Exa/Tavily behavior.                                                                                                                                                              |
| Tightened tool input schemas (`60623c04a3ae4dff048d9daf11a96fed2a152243`)           | already implemented    | Local tool schemas already bound query, limit, domain-array, URL/input, option, and provider/mode values; runtime URL validation additionally rejects unsafe/private extraction targets. Preserve the fork's wider current limits and Exa result-ID support.                               |
| Transient-aware retry policy (`9bb48328d28babd9f2e304c3d7f0b647a8bc6ef4`)           | already implemented    | Local `is_retryable_error` already distinguishes rate limits, transient HTTP statuses, provider failures, and permanent input/entitlement/endpoint errors while preserving deterministic exponential delays. This task additionally marks malformed validated payloads non-retryable.      |
| Per-request large-result controls (`c7dfc444701d024384af00d0caabbd57c0728f61`)      | conflicting            | Adding `large_result_mode`/`include_raw_contents` would change the public tool surface and bypass the fork's authenticated remote result workflow. Keep bounded server-side offload and `result_read`.                                                                                     |
| Truthful provider status (`7ad7a65378b2454b10d311c3bcd55d163b99dd14`)               | already implemented    | Local status resources report configured providers and runtime health, including degraded state and secret-safe last-error categories. Preserve that runtime-health model instead of upstream's declarative registry model.                                                                |
| Provider type/metadata cleanup (`386efb56c10b8b89140bbf78ed214f867bb55f70`)         | intentionally rejected | Its TypeScript-only cleanup and upstream README changes do not provide runtime response validation. Broad metadata/type refactoring is outside this contract sync; the fork's expanded provider metadata remains unchanged.                                                                |
| Centralized provider definitions (`3490c8d27534b05fbe900e33fb7b6491470244db`)       | conflicting            | The fork has a different provider catalog, dispatch, tool surface, and runtime-health model. Preserve local registration and dispatch.                                                                                                                                                     |
| Search runtime response validation (`21e97fc1c5a13d94826cc9a09fc2375c5cc1305a`)     | applicable             | Ported with the local Valibot `parse_provider_response` helper and current Brave, Exa, and Tavily schemas. Kagi is removed. Unlike the prior TypeScript interfaces, these schemas validate payloads at runtime.                                                                            |
| AI/GitHub runtime response validation (`67a01d54b72d02e6acecd1cd7d57b2fc48186700`)  | applicable             | Ported with runtime Valibot schemas for Exa Answer, Linkup, and GitHub code/repository/user results. Kagi FastGPT is removed.                                                                                                                                                              |
| Processing runtime response validation (`4ea9d2211bb4493a584433dde8c79aebde6c8848`) | applicable             | Ported for Exa Contents, Exa Similar, and Tavily Extract, plus operation-aware response schemas for retained upstream Firecrawl Actions, Crawl, Extract, Map, and Scrape. Fork-only Firecrawl Search and Agent use the same schema-driven helper. Kagi summarization is removed.           |
| Large-file advisory check (`372e3357a165c8fff6810036d10491a6e44261ac`)              | intentionally rejected | Tooling-only advisory work is not required for provider correctness and would change package scripts.                                                                                                                                                                                      |
| Large-result remote-offload caveats (`a362de44df6e3e3b0a9681346916b6db7ef4427f`)    | conflicting            | The fork already has authenticated pagination, a private result directory, TTL/byte/file bounds, opaque IDs, and result-store hardening; upstream's local-path/inline guidance describes a different delivery model.                                                                       |
| Normalized provider errors (`d75f2b45a8a8ee1d716f6672b83a7f6b86dd9a06`)             | already implemented    | The fork independently has typed provider errors, HTTP classification, redaction, runtime-health recording, timeout handling, and retry policy. Validation errors now add a deterministic non-retry marker without payload details.                                                        |
| Split operational documentation (`819109c1cf57baf13e276f7ee629092bc4347613`)        | intentionally rejected | Documentation reorganization is unrelated to provider correctness and would churn the fork's current operations documentation.                                                                                                                                                             |
| MCP contract tests (`aa7c1a3b3cb3c7643b2713919075692c8504ab00`)                     | already implemented    | Local tool/resource contract tests reflect the expanded fork surface. This task adds the current Exa enum assertion without importing upstream-only tool controls.                                                                                                                         |
| Brave/Kagi response-shape fix (`329a4460ded8f9bc769fe4f140a8376b38e3d77c`)          | applicable             | Retain Brave no-`web` behavior, filter non-result rows, and default omitted descriptions. Kagi portions are rejected because Kagi is removed.                                                                                                                                              |
| Provider coverage tests (`67b07702e0e9a3cf2699c14cfcc75d50dd89caf3`)                | applicable             | Ported retained-provider coverage for Exa Answer, Linkup, Exa Contents/Similar, Tavily Extract, Brave, Exa, and GitHub, adapted to current APIs and fork behavior. Upstream Kagi and Kagi enrichment/summarization tests are excluded because Kagi is removed.                             |
| Firecrawl provider coverage tests (`8d6f409330562d1c68575a82749d712bd7b62171`)      | applicable             | Ported focused valid and malformed-response coverage for the upstream-retained Firecrawl Actions, Crawl, Extract, Map, and Scrape paths. Fork-only Search also covers valid current highlights/plain descriptions and malformed nested collections; Agent is outside this coverage commit. |
| Tavily response parsing (`0bdfedd6015bd67726c6d9d2d4176e396d49bfeb`)                | already implemented    | The fork already ignores unused `response_time` semantics, safely defaults an omitted results array, and preserves current result mapping. Runtime validation retains that relaxed valid shape.                                                                                            |
| Final provider API regressions (`7cece8149195b5a4a2aee9394131102d79c79f02`)         | applicable             | Port retained-provider fixes for Exa `searchType`, Firecrawl v2 crawl parameters/status/page shapes, and Tavily date/location normalization. Kagi portions are rejected because Kagi is removed.                                                                                           |

Dependency/package-manager/version-bump commits interleaved with these
releases (pnpm, Valibot, `@types/node`, tmcp adapters/transport, tmcp,
Vitest, Vite+, Changesets, package versioning, and their merge
commits) are intentionally rejected for Task 2. The Zed settings
commit is also intentionally rejected. They are not provider-contract
fixes, and the fork already has a separately pinned dependency
baseline.

## Runtime-validation coverage and preserved shapes

The three pinned validation diffs were checked provider by provider:

- `21e97fc1c5a13d94826cc9a09fc2375c5cc1305a`: Brave, Exa, and Tavily
  are runtime-validated locally. Kagi is removed. At the audit, You
  search was a fork-only provider absent from the pinned upstream
  diff, so adding a new schema was outside that narrow port; the
  capability was later retired.
- `67a01d54b72d02e6acecd1cd7d57b2fc48186700`: Exa Answer, Linkup, and
  GitHub code/repository/user responses are runtime-validated locally.
  Kagi FastGPT is removed. Fork-only Brave Answers, Exa Deep Research,
  Tavily Research, and (at the audit) You Research are absent from the
  pinned diff and were not broadened in that task. You Research was
  later retired.
- `4ea9d2211bb4493a584433dde8c79aebde6c8848`: Exa Contents, Exa
  Similar, and Tavily Extract use provider-specific runtime schemas.
  Firecrawl Actions, Crawl, Extract, Map, and Scrape use explicit
  operation-aware schemas through the typed Firecrawl request/polling
  helpers. Fork-only Firecrawl Search and Agent are validated at those
  same boundaries, while their provider-specific tests are not
  evidence for this pinned upstream validation diff. Kagi
  summarization is removed. Fork-only Brave LLM Context is absent from
  the pinned diff.

The port deliberately preserves valid current-provider shapes that are
looser than the first upstream schemas: Brave may omit `web` and
include non-result rows; Tavily may omit `results`; Exa request/result
metadata may be absent; and current Firecrawl polling responses may
omit `success`, use terminal `failed`/`cancelled` states, contain
nullable page content, and place page URLs/errors in metadata.
Firecrawl request envelopes and provider-specific nested collections
are still validated before use; polling additionally requires a
recognized status.

Malformed-response errors contain only provider identity, issue count,
and `retryable: false`; they do not include Valibot issue summaries,
raw inputs, response payload values, response bodies, or headers. The
non-retry marker prevents repeated requests for deterministic schema
failures.

## Current provider-contract corrections

| Contract drift                                                         | Classification         | Local decision                                                                                                                                       |
| ---------------------------------------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exa `publication` replaces `research paper`                            | applicable             | Replace only the public category enum value and add a registration-level contract test.                                                              |
| Exa `pdf`, `github`, `tweet`, `startCrawlDate`, `endCrawlDate`         | intentionally rejected | These deprecated categories/parameters remain absent. Retired response fields such as `resolvedSearchType` stay optional.                            |
| Exa current `searchType` response field                                | applicable             | Accept `searchType` while preserving optional `resolvedSearchType` metadata compatibility for callers.                                               |
| Brave issue #137: omitted `web`, non-result rows, omitted descriptions | applicable             | Omitted `web` was already compatible; retain that behavior and minimally filter malformed rows/default descriptions.                                 |
| Firecrawl search highlights and plain descriptions                     | already implemented    | Current highlights arrive through the existing `description`/`snippet` fields. Controlled fixtures cover Markdown highlights and plain descriptions. |
| Firecrawl document/PDF scrape                                          | already implemented    | Existing `/scrape` markdown and metadata handling accepts the current document response shape; retain a controlled PDF fixture.                      |
| Firecrawl `research` category                                          | already implemented    | Preserve it as an ordinary academic-website filter returning web results; do not relabel it as the Research Index.                                   |
| Firecrawl v2 crawl request/status/page shapes                          | applicable             | Send `maxDiscoveryDepth`; accept status responses without `success`, terminal failure states, nullable content, and metadata URLs/errors.            |
| Tavily date and country API fields                                     | applicable             | Expand partial dates to `YYYY-MM-DD` and normalize location aliases/hyphens to Tavily's documented country values.                                   |

## Post-v0.0.28 audited main

The 67 commits from v0.0.28 through
`e6fb269f9c59208b964a593cf8c2508e0efcdb00` change only
`.github/workflows/ci.yml`, `.github/workflows/docker-image.yml`,
`package.json`, and `pnpm-lock.yaml`; there are no runtime provider
changes.

| Change group                                                                     | Classification         | Local decision                                                                   |
| -------------------------------------------------------------------------------- | ---------------------- | -------------------------------------------------------------------------------- |
| pnpm updates through 11.21.0                                                     | intentionally rejected | Keep the repository-pinned pnpm 11.9.0 for this task.                            |
| Vite+, Vitest, Valibot, Node types, Changesets, and aggregate dependency updates | intentionally rejected | Dependency refresh is separate from provider correctness and protocol migration. |
| `actions/checkout@7` and `actions/setup-node@7`                                  | intentionally rejected | CI-only maintenance is out of scope.                                             |

## Explicit non-goals

The following surface is intentionally rejected for this
synchronization commit:

- Firecrawl Developer Index and the `/search` `developer`
  category/group
- Firecrawl dedicated Research Index (`/search/research/papers` and
  related endpoints)
- Exa Agent
- Exa Connect and paid data-source integrations
- Kagi search, FastGPT, enrichment, or summarizer reintroduction
- new tools, new provider categories, or paid/enterprise feature
  surface
- dependency, package-manager, Vite+, CI, package-version, and
  server-metadata updates

This task also preserves local Firecrawl summary replacement, provider
dispatch, tool names, all schemas outside the Exa category correction,
remote pagination, URL/provider validation, runtime hardening, and the
bounded result store.

## Provider updates verified 2026-10-19

The audit and non-goals above record the 2026-08-14 decisions and are
kept as dated evidence. Later source changes supersede these
decisions; the current behavior is in
[Configuration](configuration.md#provider-notes).

- **Firecrawl `developer` category:** rejected as a non-goal above.
  Search categories are now `developer`, `gov`, `research`, and `pdf`;
  `github` is removed.
- **Firecrawl `research` category:** kept above as a web filter.
  `data.research` paper records are now parsed ahead of Firecrawl's
  2026-11-16 change to the category.
- **Exa search types:** `lite` is accepted, and `instant`, `fast`, and
  `deep-reasoning` are documented as legacy. Warnings and notices
  surface as response metadata.
- **New tools and provider surface:** rejected for that audit.
  `context_news` and the `context_answers` `ai_search` provider are
  now registered under `CONTEXT_DEV_API_KEY`.
- **HTTP 402:** now classified as credits exhausted and not retried.
