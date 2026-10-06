# Configuration

Every setting is an environment variable passed to the server process,
or a provider setting in the credentials file described below. Only
add keys for providers you intend to use; missing keys disable only
the affected tools. Keep credentials out of source control.

## Credentials file

`mcp-retriever setup` and `mcp-retriever keys` write provider keys and
URLs to `~/.config/mcp-retriever/credentials.env` (under
`$XDG_CONFIG_HOME` when that is set), as `NAME=value` lines in a file
with mode `0600`. At startup, the server loads provider keys and URLs,
`RETRIEVER_SPEND_CAPS`, and `RETRIEVER_TOOL_GROUPS` from this file.
Other controls in the table below must be set in the environment.
Nonempty environment values take precedence; an empty provider key can
be filled from the file. An explicitly empty `RETRIEVER_*` control
keeps its meaning. On non-Windows systems, a file accessible to other
users is ignored with a warning.

`RETRIEVER_CREDENTIALS_FILE` moves the file, and the value `none`
disables it. The native HTTP launcher sets it to `none` unless `.env`
names a file, so a deployment's providers come only from its
environment allowlist.

## Client example with every provider

For a source build, use `"command": "node"` and
`"args": ["/absolute/path/to/mcp-retriever/dist/index.js"]` instead.
Choose only the providers you need.

```json
{
	"mcpServers": {
		"mcp-retriever": {
			"command": "npx",
			"args": ["-y", "mcp-retriever"],
			"env": {
				"TAVILY_API_KEY": "your-tavily-key",
				"BRAVE_API_KEY": "your-brave-key",
				"BRAVE_ANSWERS_API_KEY": "your-optional-brave-answers-key",
				"GITHUB_API_KEY": "your-github-key",
				"EXA_API_KEY": "your-exa-key",
				"YOU_API_KEY": "your-you-key",
				"LINKUP_API_KEY": "your-linkup-key",
				"FIRECRAWL_API_KEY": "your-firecrawl-key",
				"CONTEXT_DEV_API_KEY": "your-context-dev-key",
				"SEARXNG_URL": "http://127.0.0.1:8080"
			}
		}
	}
}
```

## Environment variables

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
| `RETRIEVER_TOOL_GROUPS`            | Optional capability groups; see below                           |
| `RETRIEVER_RESULT_DIR`             | Private result-store directory                                  |
| `RETRIEVER_RESULT_TTL_MS`          | Result retention, default 24 hours and maximum 7 days           |
| `RETRIEVER_RESULT_MAX_BYTES`       | Per-result limit, default 25 MiB                                |
| `RETRIEVER_RESULT_STORE_MAX_BYTES` | Total quota, default 256 MiB with oldest-first eviction         |
| `RETRIEVER_SPEND_CAPS`             | Optional per-account spending caps; see below                   |
| `RETRIEVER_PROVIDER_COOLDOWN_MS`   | Default provider cooldown, 60000; `0` disables; see below       |

## Result store

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

## Optional capability groups

`RETRIEVER_TOOL_GROUPS` selects process-wide startup groups:
`research`, `media`, `business`, and `automation`. Unset/`all`
preserves the full configured catalog; `none` leaves only
`result_read`. Excluded tools cannot be discovered or called.
Mixed-purpose legacy tools require every relevant group. Empty/invalid
values reject startup. See
[focused-tool and group contracts](focused-tools-and-groups.md) for
mappings, examples, and limits of this control. It is not per-user
authorization or a provider-spend limit.

## Spending caps

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

## Provider cooldown

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

## GitHub token

For public GitHub search, use a token limited to public repository
access. Do not grant private-repository scopes unless that access is
deliberately required by your deployment.

## SearXNG

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

## Self-hosted Firecrawl

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
