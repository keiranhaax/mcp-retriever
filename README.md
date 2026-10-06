# mcp-retriever

[![built with vite+](https://img.shields.io/badge/built%20with-Vite+-646CFF?logo=vite&logoColor=white)](https://viteplus.dev)
[![tested with vitest](https://img.shields.io/badge/tested%20with-Vitest-6E9F18?logo=vitest&logoColor=white)](https://vitest.dev)

<!-- prettier-ignore -->
> [!NOTE]
> **Formerly `mcp-omnisearch`.** In October 2026 this project took a
> turn and was renamed `mcp-retriever`. It began as a customized fork
> of Scott Spence's
> [mcp-omnisearch](https://github.com/spences10/mcp-omnisearch) and
> grew into fused multi-provider search, page extraction, archive
> fallback, and stored-result read-back, so the new name says what it
> does and stops it sharing a name with the project it came from. Old
> GitHub links redirect here and tool names are unchanged. If you run
> the server yourself, see
> [Upgrading from mcp-omnisearch](#upgrading-from-mcp-omnisearch).

<!-- prettier-ignore -->
> [!IMPORTANT]
> This repository is a customized fork of
> [spences10/mcp-omnisearch](https://github.com/spences10/mcp-omnisearch).
> It preserves the original project's unified search foundation while
> maintaining a different provider catalog, expanded tool surface,
> hardened remote transport, and production-oriented result handling.
> Kagi is not included; You.com is available as a search fallback.

A Model Context Protocol (MCP) server that gives agents one interface
for web search, cited research, GitHub discovery, content extraction,
news and media search, web automation, and business intelligence.

The current fork integrates Tavily, Brave, Exa, GitHub, You.com,
Linkup, Firecrawl, and Context.dev through five consolidated tools,
thirteen focused tools, and one bounded search/read workflow. Tools
and providers are registered only when their required API keys are
available.

## What this fork adds

- **Expanded MCP surface:** 19 tools covering search, research,
  extraction, news, media, autonomous web tasks, brand intelligence,
  style guides, business classification, and transaction
  identification.
- **Modern and legacy MCP compatibility:** MCP `2026-07-28` plus
  stateless legacy `2025-11-25` support over `/mcp`.
- **Hardened HTTP transport:** a narrow guard in front of a pinned
  project-local `mcp-proxy`, with Host and Origin allowlists, strict
  routes, a 4 MiB body limit, request deadlines, and protocol-header
  enforcement.
- **Private large-result pagination:** oversized responses are stored
  with opaque IDs in a private, bounded, expiring result store and
  read through `result_read`.
- **Runtime provider health:** MCP resources report configured
  providers, recent successes, and degraded states without exposing
  credentials.
- **Defensive provider handling:** runtime response validation, typed
  and redacted errors, bounded retries, and current provider-contract
  compatibility.
- **Safer extraction:** public HTTP(S) URL validation blocks
  credentials, loopback, private networks, link-local addresses, and
  common metadata endpoints.
- **Production-oriented runtime:** explicit environment allowlisting,
  path-independent startup, pinned package tooling, and documented
  staging and rollback procedures.

## Providers

| Capability                    | Providers                                                             |
| ----------------------------- | --------------------------------------------------------------------- |
| Web search                    | Tavily, Brave, Exa, You.com                                           |
| AI answers and research       | Exa Answer, Exa Deep Research, Brave Answers, Tavily Research, Linkup |
| GitHub discovery              | GitHub                                                                |
| Extraction and processing     | Tavily Extract, Exa Contents/Similar, Firecrawl                       |
| News, media, and RAG context  | Brave News, Brave Media, Brave LLM Context                            |
| Autonomous web tasks          | Firecrawl Agent                                                       |
| Web and business intelligence | Context.dev                                                           |

Provider availability depends on configuration and provider-side
entitlements. Missing keys disable only the affected capabilities.

## MCP tools

### Structured outputs and bounded workflow

`web_search` and `web_extract` now return schema-declared
`structuredContent` alongside their existing JSON text. Full
serialized result budgets count both copies; oversized evidence
remains recoverable through `result_read`.

`search_and_read` bundles explicit-provider search and sequential
reading of a bounded set of unique URLs, with request limits,
cancellation, deadlines, and per-source failures. It does not
synthesize answers or silently fall back to another provider. Separate
search/extract tools remain preferable when selection needs judgment
or batch efficiency. See
[contracts and offline evaluation](docs/structured-search-workflow.md)
for limits, compatibility boundaries, and the measured tradeoffs.

When this server's own per-provider request queue is full, a tool
returns a `queue_full` error instead of waiting. The provider was not
contacted, so the refusal never counts against its health or starts a
cooldown; retry shortly.

### Consolidated tools

- `web_search`: search with Tavily, Brave, Exa, or You.com. Supports
  provider-aware domain filters, Brave operators, and advanced Exa
  retrieval options.
- `web_search_fused`: query two or three explicitly listed web search
  providers in parallel and merge the lists with reciprocal rank
  fusion; see below.
- `ai_search`: cited answers and research through Exa, Brave Answers,
  Tavily Research, or Linkup.
- `github_search`: search public GitHub code, repositories, and users
  with standard GitHub qualifiers.
- `web_extract`: use Tavily extraction, Exa contents/similar pages, or
  Firecrawl scrape, summarize, crawl, map, extract, actions, and
  search. Actions return a page screenshot only with
  `screenshot: true`, which costs extra credits.

### Focused tools

- `web_read`: basic public-URL reading via Tavily, Exa, or Firecrawl,
  without mode selection, crawling, or synthesis.
- `web_crawl`: a Firecrawl crawl from one public URL, using existing
  depth presets and bounded polling.
- `web_map`: Firecrawl URL discovery without page-content crawling.
- `brave_llm_context`: retrieve LLM-ready Brave grounding chunks.
- `brave_news_search`: search recent news with freshness, locale,
  SafeSearch, pagination, and extra snippets.
- `brave_media_search`: search Brave images or videos.
- `firecrawl_agent`: run credit-sensitive multi-step Firecrawl web
  tasks.
- `context_web_extract`: scrape markdown/HTML/images/screenshots,
  crawl, map sites, or search the web with Context.dev.
- `context_brand_intel`: retrieve company and brand identity data.
- `context_styleguide`: extract style-guide signals and fonts.
- `context_classify`: classify companies using NAICS, SIC, or EIC.
- `context_transaction_identify`: resolve transaction descriptors to
  brands or companies.
- `result_read`: paginate oversized results using opaque result IDs.

The exact tool list is dynamic. A tool is omitted from MCP discovery
when its required provider key is unavailable.

### Multi-provider fused search

`web_search_fused` is registered when at least two web search
providers are configured. The caller lists two or three providers
explicitly, so the explicit-provider contract holds; nothing is chosen
or substituted for them. Each provider is queried in parallel through
its ordinary path, so spending caps, cooldowns, health, metrics and
the request budget apply per provider exactly as in `web_search`.
Result URLs are canonicalised (lowercase host, no fragment, default
port or trailing slash, tracking parameters such as `utm_*` removed)
and duplicates are merged with reciprocal rank fusion (`k = 60`). Each
fused result keeps `source_providers` and the rank it held in every
provider's list; the first provider in the caller's order supplies the
title and snippet. The response lists every provider's outcome,
latency and reported usage; a provider that fails is reported there
beside partial results, and the call fails only when every provider
failed. Oversized results are retained through `result_read`.

### Archive fallback for gone pages

`web_extract` accepts `archive_fallback: true` with Tavily extract,
Firecrawl scrape or summarize, and Exa contents. When the provider
reports a requested page gone (HTTP 404 or 410, or the provider's
equivalent), the server asks the Wayback Machine availability API on
`archive.org` for the closest snapshot and reads that snapshot with
the same provider, so the extra read is paid, capped and counted like
any other. `archive.org` is the only host this adds, it is fixed, and
the server still never fetches a caller-supplied URL itself. Recovered
pages are listed under `metadata.archived` with the snapshot
timestamp, `metadata.archive_fallback` records what was attempted, and
a page with no usable snapshot leaves the original outcome unchanged.
Off by default.

### Optional capability groups

`RETRIEVER_TOOL_GROUPS` selects process-wide startup groups:
`research`, `media`, `business`, and `automation`. Unset/`all`
preserves the full configured catalog; `none` leaves only
`result_read`. Excluded tools cannot be discovered or called.
Mixed-purpose legacy tools require every relevant group. Empty/invalid
values reject startup. See
[focused-tool and group contracts](docs/focused-tools-and-groups.md)
for mappings, examples, and limits of this control. It is not per-user
authorization or a provider-spend limit.

## Search operators and provider options

Brave accepts operators directly in the query string:

- `site:example.com`, `-site:example.com`
- `filetype:pdf` or `ext:pdf`
- `intitle:term`, `inurl:term`, `inbody:term`, `inpage:term`
- `lang:en`, `loc:us`
- `before:2024`, `after:2024-01-01`
- `"exact phrase"`, `+required`, `-excluded`

GitHub search supports qualifiers such as `filename:`, `path:`,
`repo:`, `user:`, `language:`, and `in:file`.

Tavily and Exa expose provider-aware domain and retrieval options
through their tool schemas. Inspect MCP discovery for the current
schema instead of assuming every provider accepts the same fields.

### Tavily search and extraction controls

`web_search` accepts these optional fields only with
`provider: "tavily"`:

- `search_depth`: `basic`, `advanced`, `fast`, or `ultra-fast`. The
  default remains `basic`; advanced uses more provider credits. No
  automatic depth selection is enabled.
- `topic`: `general`, `news`, or `finance`. The default remains
  `general`. A country operator mapped to Tavily's `country` field
  requires `topic: "general"`.
- `time_range`: `day`, `week`, `month`, or `year`. Omitted means no
  additional recency filter. The gateway conservatively rejects a
  combination with recognized `before:`/`after:` query operators
  rather than silently choosing one date constraint.

`web_extract` retains its existing Tavily `query` and `extract_depth`
controls and adds:

- `chunks_per_source`: an integer from 1 through 5, requiring a
  non-empty query. This asks Tavily for selected chunks, not the full
  page. `result_read` can recover all content the gateway received,
  not page content the provider omitted.
- `format`: `markdown` or `text`, with no query required. Omitted
  preserves the existing provider default, Markdown.

The new fields reject use with other providers before dispatch.
Unspecified defaults, legacy response shapes, retries, pagination,
provider selection, and Firecrawl's separate format options remain
unchanged. No fallback provider or additional request is introduced.
Query-conditioned provider extraction is not local compact mode.

```json
{
	"provider": "tavily",
	"query": "recent database releases",
	"search_depth": "fast",
	"topic": "news",
	"time_range": "week"
}
```

```json
{
	"provider": "tavily",
	"url": "https://example.com/manual",
	"query": "installation requirements",
	"chunks_per_source": 3,
	"format": "text"
}
```

See [P1A provenance](docs/feature-provenance.md) for the exact donor
revisions and verified documentation contracts. Live provider behavior
and deployment require separate verification.

### Opt-in compact and full evidence

`web_search` and `web_extract` accept `response_mode` and
`output_budget_bytes`. These are local presentation controls, not
provider request options. Omission or `response_mode: "legacy"`
preserves the existing envelope and pagination behavior. P2's
provider-control sanitization applies in every mode.

- `compact`: return complete normalized results if they fit; otherwise
  return selected source passages plus a handle for the full canonical
  result. Default budget: 12000 bytes.
- `full`: return complete normalized results, using a retained handle
  when they exceed the budget. Default budget: 80000 bytes. This does
  not bypass retention quotas or fetch provider-omitted page content.
- `output_budget_bytes`: integer 2048–80000, valid only with explicit
  `compact` or `full`. Counts UTF-8 bytes of the serialized MCP tool
  result, including escaped text, **excluding JSON-RPC framing**.

```json
{
	"provider": "tavily",
	"url": "https://example.com/manual",
	"query": "installation requirements",
	"response_mode": "compact",
	"output_budget_bytes": 4096
}
```

New-mode responses carry `metadata` once per request: provider,
operation, measured adapter elapsed milliseconds, local completeness,
provider-page completeness (unknown), and safe reported request IDs
and usage when valid. Tavily response time and credits, and Exa
`costDollars.total` as USD, are reported without coercing numeric
strings. Unknown usage is `null`, not an estimated charge. No
`include_usage` request flag is added. Provider-owned metadata is
allowlisted before rendering or storage; source evidence is retained.

Compact selection uses the existing query, deterministic lexical
ranking, source-order passages, and labelled `leading`/`no_hit`
fallbacks. Source IDs are JSON Pointers within canonical `result`;
passage offsets are UTF-16 code units into that source's normalized
text, not original HTML. Source URL query parameters remain intact.
Supported headings and top-level fenced code are atomic; oversized
atoms may be omitted. This is not a complete Markdown parser or a
semantic-relevance guarantee. Limited budgets can omit whole sources;
`source_count` and `omitted_sources` make this explicit.

An exact duplicate aggregate `content` is removed only when it equals
all `raw_contents[].content` joined with two newlines. Distinct
summaries, fields, metadata, URLs, and citations remain canonical.
Small complete results avoid storage. Any local omission retains the
canonical JSON first, even below the old offload threshold. Storage
failure returns a bounded error, never an unusable handle.

Read `result_id` with `result_read`. Follow `next_offset` and
`next_byte_offset` (passed as `byte_offset`); insert a newline between
chunks only when `next_byte_offset` is absent and another page
remains. The reconstructed JSON has `metadata` and `result`, without a
second readable copy of the canonical text. Existing `.txt`/`.omr`
results and legacy readable views remain supported. TTL, oldest-first
eviction, per-result quotas, and aggregate quotas still apply.

**Privacy boundary:** this instance's clients are mutually trusted.
Opaque handles and private filesystem permissions do **not** enforce
per-client ownership. A client with access to this instance and a
valid handle can read its retained result. Do not expose it as a
multi-tenant private evidence store.

See the [P1B report](docs/search-gateway-evolution-p1b.md) for offline
validation and remaining release gates.

### Research metadata and recovery

`ai_search` and `firecrawl_agent` handlers add request-level
`_meta.retriever`: provider, operation, measured elapsed milliseconds,
reported usage or explicit unknown usage, local completeness, and
typed job/error metadata where applicable. Schema and protocol errors
that reject before dispatch retain their existing response format.

Job states are `queued`, `running`, `completed`, `failed`,
`cancelled`, or `unknown`. `partial` identifies observed unfinished
evidence. Unknown states and interrupted local waits do not prove
completion or remote cancellation. Firecrawl creation alone reports
typed state `unknown`; its legacy body still says `processing`.
Cancellation is confirmed only by acknowledgement or a cancelled
status observation. Job-scoped usage is an observation, not another
charge on every poll.

An error with a known job ID has JSON text `{error, job, result?}`;
`result` contains available partial evidence or a `result_read`
handle. These responses retain `isError: true`. The entire serialized
async tool result, including `_meta` and escaped text, is capped at
80000 UTF-8 bytes, excluding JSON-RPC framing. Retention failure
reports `local_completeness: "unavailable"`, keeps job recovery
information, and never issues a false handle. `complete` means all
locally returned evidence is inline, not that the remote job or
original page is complete.

Resume Tavily with `action: "status"` and `request_id`; use Firecrawl
`action: "status"` or `"cancel"` with `job_id`. These actions never
create replacement jobs. Partial observations survive failures within
the current bounded wait, not through a new persistent job registry.
The shared trusted-client boundary also applies to job IDs; there are
no per-client ownership checks.

P2 strips provider-owned headers, configuration, and raw diagnostics
from supported Firecrawl/Exa envelopes before inline output or
storage. It preserves document text, citation IDs, URLs, and extracted
JSON fields such as `token` or `api_key`. It is not a general secret
scanner for source content. See the
[P2 report](docs/search-gateway-evolution-p2.md) for exact scope,
compatibility changes, and unverified live gates.

## Configuration

### Local stdio client

Build the project, then configure any stdio-capable MCP client:

```json
{
	"mcpServers": {
		"mcp-retriever": {
			"command": "node",
			"args": ["/path/to/mcp-retriever/dist/index.js"],
			"env": {
				"TAVILY_API_KEY": "your-tavily-key",
				"BRAVE_API_KEY": "your-brave-key",
				"BRAVE_ANSWERS_API_KEY": "your-optional-brave-answers-key",
				"GITHUB_API_KEY": "your-github-key",
				"EXA_API_KEY": "your-exa-key",
				"LINKUP_API_KEY": "your-linkup-key",
				"FIRECRAWL_API_KEY": "your-firecrawl-key",
				"CONTEXT_DEV_API_KEY": "your-context-dev-key"
			}
		}
	}
}
```

Only add keys for providers you intend to use. Keep credentials out of
source control.

### Environment variables

| Variable                           | Capability                                                      |
| ---------------------------------- | --------------------------------------------------------------- |
| `TAVILY_API_KEY`                   | Tavily search, extraction, and research                         |
| `BRAVE_API_KEY`                    | Brave web, news, media, LLM context, and Answers fallback       |
| `BRAVE_ANSWERS_API_KEY`            | Optional separate Brave Answers credential                      |
| `GITHUB_API_KEY`                   | GitHub code, repository, and user search                        |
| `EXA_API_KEY`                      | Exa search, answers, deep research, contents, and similar pages |
| `YOU_API_KEY`                      | You.com web search fallback                                     |
| `LINKUP_API_KEY`                   | Linkup sourced answers                                          |
| `FIRECRAWL_API_KEY`                | Firecrawl processing, search, and agent tools                   |
| `FIRECRAWL_BASE_URL`               | Optional self-hosted Firecrawl base URL                         |
| `FIRECRAWL_AGENT_URL`              | Optional Firecrawl Agent endpoint override                      |
| `CONTEXT_DEV_API_KEY`              | Context.dev web and business-intelligence tools                 |
| `SEARXNG_URL`                      | Optional self-hosted SearXNG search; off when unset             |
| `RETRIEVER_RESULT_DIR`             | Private result-store directory                                  |
| `RETRIEVER_RESULT_TTL_MS`          | Result retention, default 24 hours and maximum 7 days           |
| `RETRIEVER_RESULT_MAX_BYTES`       | Per-result limit, default 25 MiB                                |
| `RETRIEVER_RESULT_STORE_MAX_BYTES` | Total quota, default 256 MiB with oldest-first eviction         |
| `RETRIEVER_SPEND_CAPS`             | Optional per-account spending caps; see below                   |
| `RETRIEVER_PROVIDER_COOLDOWN_MS`   | Default provider cooldown, 60000; `0` disables; see below       |

The result directory is created with mode `0700`; stored results use
mode `0600`. `result_read` returns at most 500 lines and 12,000 UTF-8
content bytes per request, including when a single line is longer. Use
`next_offset` as the next `offset`, and `next_byte_offset` as the next
`byte_offset` (reset to zero when absent). Line-limited pages omit
their separator newline; byte-limited pages preserve it. The stored
`FULL RESULT JSON` section retains every original field; the preceding
text and bounded section outline are navigation aids. The
inline/offload threshold is 80,000 UTF-8 bytes including JSON escaping
in the MCP text payload. Near the storage quota, only the canonical
JSON view is stored; optional readable copies are omitted.

### Spending caps

`RETRIEVER_SPEND_CAPS` is off by default. Set it to a comma-separated
list of `account:daily|monthly:usd|credits=amount` entries, for
example
`exa:daily:usd=1.50,exa:monthly:usd=20,tavily:monthly:credits=1000`.
An account is a credential family (`exa`, `tavily`, `firecrawl`,
`brave`), which covers every provider sharing that key, or one exact
provider name such as `exa_deep_research`. Every Context.dev tool is
the single provider `context_dev`, which is also how its health,
metrics and cooldown are keyed. Periods are UTC days and months; USD
and credits are tracked separately and never converted. A malformed
entry fails startup.

Only provider-reported usage from real requests counts: Exa returns
USD, Tavily and Firecrawl Agent return credits, and HTTP cache hits
and repeated job status reads add nothing. Providers that report no
usage can only be stopped with a cap of `0`. Running totals persist in
`spend-ledger.json` inside the result directory (mode `0600`, atomic
writes). When a cap is reached, every tool that would start paid work
on that account returns a `spend_cap` error naming the account, cap
and `reset_at`; nothing is rerouted, and job status or cancel actions
stay available. The `retriever://providers/status` resource reports
`spend_caps` with current totals, caps and reset times per account.

### Provider cooldown

When a provider call ends, after its retries, in a rate limit (HTTP
429, or a provider's own rate-limit signal) or a 5xx, that provider
enters a short in-memory cooldown. The window is the provider's
`Retry-After` when present, clamped to 15 minutes, otherwise
`RETRIEVER_PROVIDER_COOLDOWN_MS` (default 60000; `0` disables the
feature). Authentication, entitlement, validation, local timeouts and
policy refusals never start one. While cooling, tools that would start
new work for that provider return a `provider_cooldown` error with
`retry_at` and the triggering `trigger_status`; nothing is rerouted,
and job status or cancel actions stay available. In `search_and_read`
a cooling extract provider is one failed source. The
`retriever://providers/status` resource shows `cooldown_until` per
provider while a window is active. The unit is the same category and
provider pair that provider health tracks, so Tavily extraction and
Tavily search cool down independently. A restart clears every
cooldown.

### GitHub token

For public GitHub search, use a token limited to public repository
access. Do not grant private-repository scopes unless that access is
deliberately required by your deployment.

### SearXNG

Set `SEARXNG_URL` to the origin of a SearXNG instance you operate, for
example `http://127.0.0.1:8080`, and `web_search`, `web_search_fused`
and `search_and_read` gain the `searxng` provider. The variable is off
by default, needs no key, and is passed through the native launcher's
environment allowlist. The instance must enable its `json` output
format (`search.formats` in SearXNG's settings), or every call fails
with a `SearXNG refused JSON output` error. Results carry the engines
that produced them; `include_domains` and `exclude_domains` are
applied locally after retrieval, and `limit` truncates the instance's
single result page. SearXNG reports no usage, so only a spending cap
of `0` or the request budget bounds it, and its health, cooldown and
metrics are keyed `search:searxng`.

### Self-hosted Firecrawl

Set `FIRECRAWL_BASE_URL` to a Firecrawl instance exposing the expected
v2 endpoints. A `FIRECRAWL_API_KEY` is still required. Use
`FIRECRAWL_AGENT_URL` only when the Agent endpoint differs from the
base URL. An explicit Agent override is exclusive: errors never retry
against the public cloud. Firecrawl API requests reject redirects,
including create, polling, status, and cancellation, so a redirect
cannot silently forward a private prompt to another origin. Configure
the final API URL rather than a redirecting alias.

`firecrawl_agent` starts a new paid job by default. Its default
`max_credits` cap is **100**, and zero, negative, fractional, or
unsafe integer caps are rejected before networking. The default model
is `spark-2`; legacy model aliases remain accepted. MCP start returns
a job ID immediately by default (`wait_for_completion: false`). Use
`action: "status"` or `action: "cancel"` with that `job_id`, or opt
into `wait_for_completion: true` for a bounded wait. Repeating `start`
creates a new job. Creation is not automatically retried. Local
cancellation/deadlines stop waiting and polling, not necessarily the
remote paid job; use explicit `cancel` to request remote termination.
If creation fails before a job ID is received, its outcome is unknown.
Errors after an accepted start retain that ID and safe status/cancel
guidance. Scrape workers stop dequeuing after rate limiting; crawl
continuations must report completion. Crawls fetch at most ten result
pages and report `truncated`, `next`, and the provider's totals when
more remain, rather than implying full retrieval.

Extraction URL and Context domain/direct-URL checks reject literal
private/reserved addresses and local names. They are not an SSRF
sandbox: DNS, redirects, and discovered crawl URLs are resolved by the
remote provider, which must enforce retrieval-time destination policy.

### Search evaluation

`src/common/fixtures/eval-queries/manifest.json` holds 25 fixed
queries across docs, code, news and general topics, each with anchor
URLs or domains that count as correct. `scripts/eval-search.mjs`
scores a run per provider: hit@1, hit@5, mean reciprocal rank, latency
and provider-reported cost, overall and per category, as `report.json`
and `report.md` under the ignored `reports/eval/` directory.

```bash
# Offline: score a recorded run; no network.
node scripts/eval-search.mjs --input reports/eval/<run>/run.json

# Live: explicit flag, explicit per-run budgets, built server required.
node scripts/eval-search.mjs --live --providers tavily,exa \
  --budget-usd 0.50 --budget-credits 50 --env .env
```

Live mode calls `web_search` on `dist/index.js` through MCP, so
spending caps, cooldowns, metrics and request budgets apply exactly as
in production; `RETRIEVER_SPEND_CAPS` from the environment or the
credentials file is passed through. It stops as soon as the reported
spend reaches either budget (ceilings 5 USD and 500 credits per run),
bounds raw requests with the same guard as `scripts/verify-live.mjs`,
and records every request in `requests.jsonl`. Providers that report
no usage (Brave, You.com) are bounded only by request count. Add
`--fuse` to score the fused `providers` list beside each single
provider.

## Transport and deployment

### Stdio

The core server runs over stdio:

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm run build
node dist/index.js
```

### Hardened MCP HTTP deployment

This fork includes a production deployment path:

```text
client -> HTTP guard -> mcp-proxy@6.7.3 -> stdio server
```

It supports modern MCP `2026-07-28` and stateless legacy MCP
`2025-11-25` on `POST /mcp`. `GET /ping` is the only health route. The
legacy `/sse` route is intentionally retired.

The reliability candidate checks the API key in constant time in the
guard **before body intake**, and checks it again in the proxy.
Connection, concurrent-request, and global request-rate bounds are
configurable. The pinned transport patches are applied through
`pnpm-workspace.yaml` and `pnpm-lock.yaml`, not manual dependency
edits. See:

- [Production deployment](docs/deployment.md)
- [MCP 2026-07-28 architecture decision](docs/architecture-decision-mcp-2026-07-28.md)
- [Provider synchronization matrix](docs/provider-synchronization.md)

The checked-in production runbook documents this fork's deployed
topology. Adapt hosts, ports, process management, and credentials for
your own environment.

### Docker and OpenAPI

The Docker image uses MCPO to expose the stdio server as HTTP/OpenAPI
for clients such as OpenWebUI:

```bash
git clone https://github.com/keiranhaax/mcp-retriever.git
cd mcp-retriever
cp .env.example .env 2>/dev/null || touch .env
# Set a non-blank MCP_API_KEY and only the provider keys you need
docker compose up -d --build
```

The default container port is `8000`, and the generated MCPO route is
`/retriever`. This Docker/MCPO path is separate from the hardened
native `/mcp` deployment described above. Compose injects `.env`,
requires `MCP_API_KEY`, and publishes only on `127.0.0.1` by default.
MCPO requires the configured key in its Bearer authentication header,
including for documentation routes (`strict_auth`). `MCPO_BIND_HOST`
changes the host publication address; `PORT` changes both ports. Do
not expose it publicly without a separately reviewed ingress policy.
MCPO and its Python dependencies are pinned and installed at image
build time. No runtime package download or shell-based credential
substitution is used. The temporary JSON configuration is private; the
inbound API key is neither in that file nor the command line.

## Examples

### Brave operator search

```json
{
	"query": "filetype:pdf site:microsoft.com +typescript -javascript",
	"provider": "brave",
	"limit": 10
}
```

### Exa deep research

```json
{
	"query": "Compare current MCP transport security guidance",
	"provider": "exa_deep_research",
	"exa_deep_search_type": "deep-reasoning"
}
```

### Firecrawl search

```json
{
	"provider": "firecrawl",
	"mode": "search",
	"query": "Model Context Protocol security",
	"firecrawl_search_options": {
		"sources": ["web", "news"],
		"limit": 10
	}
}
```

### Read an oversized result

```json
{
	"result_id": "opaque-id-returned-by-another-tool",
	"offset": 1,
	"limit": 200
}
```

## Development

Requires Node.js 22 or newer and Corepack with the repository-pinned
pnpm release. Use an isolated worktree, not the live deployment
checkout, for development.

- [Contributor guide](CONTRIBUTING.md): authoritative setup commands,
  dependency isolation, conventions, and checks by change type.
- [Agent guidance](AGENTS.md): project invariants and working
  boundaries.
- [Deployment runbook](docs/deployment.md): native deployment,
  verification, and rollback.
- [Agent handoff](docs/agent-handoff.md): documentation reconciliation
  and separate unfinished work.

Documentation-only edits do not require the runtime integration gate.
Docker checks apply only to separately scoped Docker work, not the
native Node/PM2 deployment.

## Upgrading from mcp-omnisearch

This project was called `mcp-omnisearch` until October 2026. Tool
names, tool arguments, and provider keys such as `TAVILY_API_KEY` are
unchanged. Everything that carried the old name changed in one
breaking step, with no aliases:

| Before                                                 | Now                              |
| ------------------------------------------------------ | -------------------------------- |
| `OMNISEARCH_*` environment variables                   | `RETRIEVER_*`, same suffixes     |
| `omnisearch://` resource URIs                          | `retriever://`                   |
| `_meta.omnisearch` in tool results                     | `_meta.retriever`                |
| `~/.cache/mcp-omnisearch/results` default result store | `~/.cache/mcp-retriever/results` |
| `mcp-omnisearch` package, bin, and Compose service     | `mcp-retriever`                  |
| `/omnisearch` MCPO route in the Docker image           | `/retriever`                     |
| `ApiKey realm="omnisearch"` in `WWW-Authenticate`      | `ApiKey realm="retriever"`       |

To move an existing installation:

1. Rename every `OMNISEARCH_*` setting in your environment or `.env`.
   `start-server.sh` exits and names any legacy variable it still
   finds, so a setting such as a spending cap cannot switch off
   unnoticed. The direct stdio and Docker launch paths ignore the old
   names without warning, so check those by hand.
2. If you use the default result store, move `~/.cache/mcp-omnisearch`
   to `~/.cache/mcp-retriever` to keep stored results and the
   spending-cap totals in `spend-ledger.json`.
3. Update clients that read `omnisearch://` resources or
   `_meta.omnisearch`, and any configured path to `dist/index.js`.
4. Optionally point an existing clone at the new URL with
   `git remote set-url origin https://github.com/keiranhaax/mcp-retriever.git`.
   The old URL redirects.

## Fork scope and upstream relationship

This is a maintained customization, not a drop-in mirror of upstream.
Notable differences include:

- Kagi is removed; You.com is retained as a search fallback.
- Brave, Firecrawl, Exa, and Context.dev capabilities are expanded.
- Result delivery uses private authenticated pagination rather than
  exposing local filesystem paths to remote clients.
- The fork retains its own provider dispatch, runtime-health model,
  validation, and deployment architecture.
- Upstream changes are reviewed and selectively ported instead of
  merged blindly when they conflict with the fork's contracts or
  production safeguards.

The original project and authorship remain credited to
[Scott Spence's mcp-omnisearch](https://github.com/spences10/mcp-omnisearch).
The rename does not change that: this project exists because of
mcp-omnisearch, and upstream changes are still reviewed and ported.
See the repository's fork relationship and Git history for provenance.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.
Keep changes focused, preserve public MCP contracts unless a breaking
change is intentional, and include verification for provider, schema,
transport, or deployment changes.

## License

MIT License. See [LICENSE](LICENSE).

## Acknowledgments

This customized fork builds on the original
[mcp-omnisearch](https://github.com/spences10/mcp-omnisearch) and the
services provided by:

- [Model Context Protocol](https://github.com/modelcontextprotocol)
- [Tavily](https://tavily.com)
- [Brave Search](https://search.brave.com)
- [Exa](https://exa.ai)
- [GitHub](https://github.com)
- [Linkup](https://linkup.so)
- [Firecrawl](https://firecrawl.dev)
- [Context.dev](https://context.dev)
