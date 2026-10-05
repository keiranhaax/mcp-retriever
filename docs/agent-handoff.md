# Documentation handoff

## Guidance reconciliation (2026-09-07)

Documentation-only update based on canonical source commit `047a7e1`.
The checkout was on `main`; this is a source snapshot, not deployed
artifact identity. No runtime inspection or deployment is implied.

- `AGENTS.md` now owns project invariants and targeted navigation,
  deferring shared approval/preservation rules to host guidance.
- `CONTRIBUTING.md` owns current Vite+/Corepack commands,
  private-store safety, and validation by change type.
- The Copilot adapter points to those files instead of adding global
  installations, blanket formatting, or automatic release steps.
- README links to authoritative contributor instructions rather than
  repeating the gate. The deployment runbook distinguishes historical
  verification from current state and excludes Docker from the
  selected native deployment's gate.

The implementation was prepared in
`/home/ubuntu/worktrees/mcp-omnisearch-docs-guidance-20260907` and is
intended for the canonical checkout as an uncommitted documentation
update. No Git staging, commit, merge, publication, dependency change,
provider call, production build, or restart is part of this scope.

## Separate unfinished work

At inspection, these existing worktrees contained uncommitted docs:

- `/home/ubuntu/worktrees/mcp-omnisearch-agent-architecture`, branch
  `docs/agent-architecture-20260831`, based on `37e19fe`: architecture
  and operability drafts plus edits across project documentation.
- `/home/ubuntu/worktrees/mcp-omnisearch-reliability-20260905`, branch
  `fix/reliability-audit-20260905`, at `047a7e1`: earlier guidance
  cleanup and an untracked `docs/agent-handoff.md`.

Both worktrees and their untracked files are preserved. This cleanup
adapts relevant guidance from those drafts; it does not merge their
files or certify their architecture and checkpoint claims. Before
resuming either worktree, inspect current status and reconcile its
instructions with the canonical docs. Do not copy stale checkpoint
claims or overwrite unfinished work wholesale.

## Verification

The prepared snapshot passed Vite+ formatting on all six changed
Markdown files, 22 local-link checks, referenced source-path and
package-script checks, instruction-consistency review, and
`git diff --check`. The complete diff and new handoff were reviewed.
Pre-existing modified/untracked files in the canonical checkout and
both existing documentation worktrees matched their fingerprints.

The new worktree has no dependencies. Formatting used the already
installed Vite+ binary from the reliability worktree, running there
against explicit target paths with its byte-identical formatter
configuration. No dependency installation was needed.

Runtime tests were not rerun for this prose-only update; historical
provider/runtime results remain in their existing records. Behavioral
improvement in future agent sessions is not established by formatting
and document checks alone.
