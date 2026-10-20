# P0 MCP discovery fixtures

These JSON files were captured from the built `dist/index.js` at
`047a7e1e3fce8451753e0e8bcffef6dcd13b4554` using synthetic keys and
separate temporary homes/results. They are observed local MCP output,
not fabricated schemas or live entitlement evidence.

- `all-providers.json`: 15 tools (14 as captured plus `context_news`).
- `no-providers.json`: only `result_read`.
- `no-github.json`: 14 tools (13 as captured plus `context_news`), no
  `github_search`.
- `tavily-only.json`: search, extraction, research, and `result_read`.

On 2026-10-19 the committed fixtures were amended by hand, not
recaptured, for provider-contract updates: the Exa `lite` search type,
the Firecrawl `developer`/`gov` categories, the `context_answers`
`ai_search` provider, the `context_web_extract` `map` mode and search
options, the `context_news` tool, and the Context.dev `context`
search/read provider. Recapture with `--update` from an approved
isolated worktree and review the diff before treating them as observed
output again.

Run `node src/server/fixtures/evolution-discovery/capture.mjs` from an
approved isolated worktree after its build. The default verifies the
committed fixture contents without overwriting them. `--update`
explicitly recaptures them; review every resulting schema change. The
script uses fixture credentials only, blocks child `fetch` and
`net.Socket.connect`, bounds output/RPC deadlines, and tears down its
own processes and result directories. This is a test harness, not an
OS network sandbox or Defuddle safety proof.

Direct tmcp stdio negotiates `2025-06-18` when the fixture requests
`2025-11-25`. Modern/legacy HTTP behavior is separately covered by
`scripts/smoke-mcp.mjs`. Do not infer direct stdio protocol support
from proxy discovery.

`src/server/evolution_discovery.test.ts` compares actual source-server
`tools/list` against these captured files and checks registration
schemas using the installed `ValibotJsonSchemaAdapter`. Cold-start
cases reset the module graph. A separate characterization test records
stale singleton registration after in-process key removal; this is a
baseline gap, not desired reload behavior.
