# Changelog

All notable changes to `@kortix/shared` are documented here. Format loosely
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

### Added

- **`HARNESSES` / `HARNESS_IDS`** (`src/harnesses.ts`) — the canonical harness
  descriptor: one `HarnessDescriptor` per supported harness (`claude`,
  `codex`, `opencode`, `pi`) covering label, config directory, ACP adapter
  package, stability, model namespacing, default-model ownership, live-model-
  change support, and the founder auth-kind matrix. `harnessesByStability()`
  returns the harness ids at a given stability tier. This is now the single
  source of truth that `manifest-schema`, `apps/api`, `apps/web`,
  `@kortix/sdk` (via a devDependency-guarded mirror), and the sandbox agent
  server (same) all derive their harness knowledge from — see `README.md`
  for the full derivation map.
- **`./harnesses` subpath export** (`package.json`) — lets a consumer that
  needs only harness identity import `@kortix/shared/harnesses` directly
  without pulling in the root barrel's `./tools` re-export. Added for the
  sandbox agent server's conformance test, which cannot tolerate the root
  barrel under that app's stricter `noUncheckedIndexedAccess` typecheck (see
  `apps/kortix-sandbox-agent-server/src/acp/harness-registry.conformance.test.ts`'s
  own header comment).
- **`README.md`** — the harness descriptor guide: a field-by-field reference
  for `HarnessDescriptor`, the full derivation map (every consumer of
  `HARNESSES`/`HARNESS_IDS` and where), the harness matrix table, the
  2026-07-15 founder auth decisions and the named tests that pin them, the
  `experimental_harnesses` gating rules and gate sites, and a step-by-step
  "how to add a harness" operator note (what's automatic vs. what needs
  manual thought).
