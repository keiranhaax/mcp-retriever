# Focused web tools and capability groups

Phase 2 builds on
[structured outputs and the search/read workflow](structured-search-workflow.md).
It keeps the existing tools and provider behavior available by
default. Nothing here is a production deployment or a change to live
credentials.

## Focused operations

- `web_read`: public URL or nonempty array of up to 20 URLs. Choose a
  configured Tavily, Exa, or Firecrawl provider. Only basic page
  retrieval is supported: Tavily extract, Exa contents, or Firecrawl
  scrape. There is no mode selector, crawling, actions, advanced
  extraction or synthesis. Optional `query` supports local passage
  selection; Tavily additionally accepts `chunks_per_source` and
  `format`, with the same provider-specific validation as the
  underlying extraction adapter.
- `web_crawl`: one public URL, Firecrawl only. Existing basic/advanced
  depth presets and page limits apply. This starts a potentially
  billable crawl and waits using existing bounded polling. It is not
  an idempotent operation; do not retry an uncertain start blindly.
- `web_map`: one public URL, Firecrawl only. Existing basic/advanced
  link limits apply. Discovers URLs without fetching their page bodies
  through a crawl workflow.

These tools reuse the registered adapters, safe errors, structured
results, byte-budget presentation, and retained-evidence storage from
phase 1. They reject extra fields rather than silently ignoring
parameters for a different operation. Inputs are public HTTP(S) URLs,
never Exa opaque result IDs. Provider-side retrieval still owns
DNS/redirect policy; syntactic URL validation is not an end-to-end
SSRF guarantee.

Use `web_extract` for the existing broad/advanced provider surface. No
old name, input schema or omitted default is removed. Focused tools
expose intent more clearly; a larger tool count is deliberate, not a
regression by itself. Client-side discovery and code-mode composition
remain unchanged.

## Startup capability selection

`RETRIEVER_TOOL_GROUPS` controls the tools registered by each server
instance. It is process-wide startup configuration, not per-request or
per-user authorization. A change requires restarting that configured
instance; this phase does not change the live deployment.

Accepted values:

- Unset or exactly `all`: every configured tool, including focused
  tools.
- Exactly `none`: only `result_read`.
- A comma-separated list of `research`, `media`, `business`,
  `automation`. Whitespace surrounding list elements is ignored;
  duplicates are accepted. Empty, unknown, mixed `all`/`none`, and
  oversized values reject startup without echoing the supplied value.
  Names are case-sensitive.

The native launcher preserves an explicitly empty variable so it fails
closed in the server rather than silently becoming an unset/full
catalog. The variable is allowlisted through `env -i`; no other
environment widening is introduced.

Groups:

- Research: `web_search`, `web_search_fused`, `github_search`,
  `ai_search`, `brave_llm_context`, `brave_news_search`,
  `search_and_read`, `web_read`.
- Media: `brave_media_search`.
- Business: `context_brand_intel`, `context_styleguide`,
  `context_classify`, `context_transaction_identify`.
- Automation: `firecrawl_agent`, `web_crawl`, `web_map`.
- Mixed legacy surface: `web_extract` and `context_web_extract`
  require research **and** media **and** automation. They expose
  multiple modes, including media retrieval and crawling/actions.
  Requiring every group prevents a read-oriented configuration from
  retaining broader alternate entry points. This conservative rule
  does not vary with provider keys.
- `result_read` is always available so retained evidence remains
  readable.

A disabled tool is never registered, so it is absent from discovery
and a manual `tools/call` receives the existing unknown-tool error
before schema validation, provider dispatch, or billing. Tests cover
these direct calls, not just hiding names. Provider keys remain an
independent availability requirement. Provider-status resources report
configured providers and runtime health, not the selected tool groups.

These groups restrict the MCP tool surface, not what every external
provider can infer or return. Research is not synonymous with free or
read-only: AI research tools can create paid jobs. Groups do not
enforce per-user data ownership, provider credits, budgets for every
tool, URL/domain allowlists, or tenant isolation. `result_read`
retains the existing shared credential/storage boundary. Do not expose
one credential as multiple independent tenants based on these groups.

### Example client configuration

For a separate stdio instance with provider credentials configured
securely, add this non-secret environment value to its client
configuration:

```json
{
	"env": {
		"RETRIEVER_TOOL_GROUPS": "research"
	}
}
```

This is a configuration fragment, not a complete launch command or a
request to edit a running client. A remote server operator sets the
same variable on the server process. There is no URL query parameter
or caller-controlled header that can widen the configured catalog.

## Preservation and verification

Phase-1 source was backed up before edits under
`/home/ubuntu/backups/mcp-omnisearch-phase1-20260912T215352Z/`. Its
manifest verifies archived source bytes; dependencies, credentials,
build output, and unrelated worktrees are excluded. Restore into a new
empty directory and verify `manifest.json`; do not overwrite live
state.

Use the existing private dependencies and isolated offline probes:

```bash
./node_modules/.bin/vitest run src/server/capability_groups.test.ts src/server/launcher_groups.test.ts src/server/tools/focused_web.test.ts
./node_modules/.bin/vp check
./node_modules/.bin/vitest run
./node_modules/.bin/vp pack
shellcheck start-server.sh
node scripts/smoke-mcp.mjs
node scripts/smoke-search-workflow.mjs
node scripts/smoke-tool-groups.mjs
node scripts/smoke-group-http.mjs
node src/server/fixtures/evolution-discovery/capture.mjs --focused
node src/server/fixtures/evolution-p1b/smoke.mjs
git diff --check
```

The launcher test uses a temporary script copy with the shared
credential path redirected to an absent temporary file and a stub Node
executable. It checks exact environment forwarding without reading
real credentials or starting a service. Group smoke tests use fresh
processes, fixture keys, and blocked provider networking. The HTTP
probe checks both supported protocol eras with manual calls to
excluded tools.

## Verified source checkpoint

Phase 2 extends the uncommitted
`feature/structured-search-workflow-20260912` worktree. The source
baseline for this phase is the verified phase-1 backup above, not the
older branch HEAD.

- Full suite: 1969 tests passed across 80 files, no failed or skipped
  tests. Phase 2 adds 112 test cases to the 1857-test phase-1
  checkpoint.
- Vite+ formatting, lint/types, build, and launcher ShellCheck passed.
- Independent reviews of the focused tools and
  capability-group/launcher changes passed with no blocking security
  or logic findings.
- Default configured discovery exposes 18 tools. Fresh-process groups
  expose 8 research, 2 media, 5 business, 4 automation, or 1
  retained-result tool for `none`; counts depend on configured
  credentials.
- Eight valid startup profiles passed discovery and explicit
  denied-call probes; empty and invalid settings rejected startup
  without provider networking. Research-only restrictions also passed
  over both HTTP protocol eras.
- Built positive-path probes exercised `web_read`, `web_map`, and
  `web_crawl`, with fixture-only provider responses and structured
  output.
- The focused discovery delta (`--focused`) passed all four credential
  profiles while preserving historical schema/snapshot bytes. Older
  phase flags remain historical comparisons, not current-phase gates.

No dependency/instruction files changed, and no phase-1 files were
removed. Source changes remain uncommitted and undeployed; no Git
publication, live provider billing, production build, or service
restart was performed. Actual provider availability, latency, and
agent-selection accuracy are not established by offline fixtures.
