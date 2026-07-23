# OpenCode Root Dir + Model-Connect UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move OpenCode's default config dir from `.kortix/opencode` to root-level `.opencode` (matching `.claude`/`.codex`/`.pi`) with a legacy fallback so no existing project breaks; collapse the three parallel model pickers + three connect entry points into one picker, one connect modal, and one source of connection truth; and restructure the Models management surface + composer pill row so the whole connection experience reads for non-technical users (spec Part 3: 8 gateway tabs → 3, "you're set" landing view, de-jargoned copy, VariantSelector deleted, Thinking pill, one pill law, mode-typed ACP options).

**Architecture:** Phase 1 flips the canonical `configDir` in `packages/shared/src/harnesses.ts` (everything in apps/api and apps/web derives from it), updates the independent hardcoded copies (registry, sandbox Dockerfile layer, snapshots, CLI, starter templates), and adds an existence-based legacy fallback at the two places that can see files (sandbox harness registry, API git scanner). Phase 2 consolidates connection state into the SDK's `useModelsPage` projection, mounts one global connect modal, brings the Claude subscription form to parity with ChatGPT's, defaults the `unified_model_picker` flag on and deletes the legacy pickers, adds the not-connected picker state, and extracts the selector blocks out of `session-chat-input.tsx`.

**Tech Stack:** TypeScript, bun test (co-located `*.test.ts`), React 18, `motion/react`, Tailwind + kortix tokens, Playwright e2e.

**Spec:** `docs/superpowers/specs/2026-07-20-opencode-dir-and-model-connect-ux-design.md` — read it before starting any task. The full inventory of `.kortix/opencode` occurrence sites (file:line) is in that spec's Part 1 table.

## Global Constraints

- **NEVER commit or push — anywhere, ever — unless Jay explicitly says so in the executing session.** Every task ends at a verification checkpoint, not a commit. This overrides the default TDD-commit cadence and any skill step that says "commit".
- Testing law (repo `testing` skill): every change ships tests in the same change. Co-located bun tests, deterministic, no comments narrating changes.
- Phase 1 and Phase 2 each happen in their own worktree (`pnpm worktree start`, `nvm use 22` first — default Node 26 breaks worktree start).
- Line numbers cited are from the 2026-07-20 survey of `acp-harness-runtime-v2`; re-anchor with a search if the file has drifted. Always read the target region before editing.
- SDK (`packages/sdk`): additive public API only; `packages/sdk/src/acp/**` and isomorphic-core tiers stay framework-free; gates `pnpm --filter @kortix/sdk typecheck && test && smoke:install`.
- Web UI: kortix-design-system is law — `kortix-*` colors only, `rounded-md` panels, `Loading` never `Loader2`, `Hint` not `Tooltip`, `Modal` not `Dialog`, toast helpers from `components/ui/toast.tsx`, `ConfirmDialog` before destructive mutations. Motion: ease-out <300ms, springs `{ type: 'spring', duration: 0.3, bounce: 0 }`, `AnimatePresence initial={false}`, `active:scale-[0.97]` on pressed triggers, `prefers-reduced-motion` respected. Load skills `kortix-design-system` + `make-interfaces-feel-better` before any Phase 2 task.
- Never hand-edit `__snapshots__/*.snap` — regenerate via the test runner's snapshot-update mode and eyeball the diff.
- e2e contract `tests/e2e/specs/14-acp-harness-selector.spec.ts` (`data-testid="harness-model-selector"`, `agent-option`, `data-harness`) must pass unmodified at every checkpoint of Phase 2.

---

## Phase 1 — OpenCode config dir → `.opencode`

### Task 1: flip the canonical descriptor

**Files:**
- Modify: `packages/shared/src/harnesses.ts:93`
- Test: `packages/shared/src/harnesses.test.ts:33`

**Interfaces:**
- Consumes: nothing.
- Produces: `HARNESSES.opencode.configDir === '.opencode'` — every derived consumer (`compile-runtime-config.ts` `DEFAULT_CONFIG_DIR`, `agent-config-v2.ts` v3 profiles, web `runtime-profile-options.ts`) picks this up with no code change.

- [ ] **Step 1: Update the pinned test to the new value (RED)**

In `packages/shared/src/harnesses.test.ts:33` change:

```ts
expect(HARNESSES.opencode.configDir).toBe('.kortix/opencode');
```

to:

```ts
expect(HARNESSES.opencode.configDir).toBe('.opencode');
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @kortix/shared test -- harnesses`
Expected: FAIL — received `.kortix/opencode`.

- [ ] **Step 3: Flip the descriptor (GREEN)**

In `packages/shared/src/harnesses.ts:93` change `configDir: '.kortix/opencode',` to `configDir: '.opencode',`.

- [ ] **Step 4: Run the shared suite**

Run: `pnpm --filter @kortix/shared test`
Expected: harnesses tests PASS; the sandbox layer-render snapshot test (`packages/shared/src/sandbox/__tests__/layer-render.test.ts:203`) now FAILS — that is Task 4's work; note it and continue.

### Task 2: registry default + fixture sweep for derived consumers

**Files:**
- Modify: `packages/registry/src/manifest.ts:13`
- Modify: `packages/registry/src/manifest.test.ts` (assertions at lines 3, 19-26)
- Modify: `apps/api/src/projects/lib/__fixtures__/compile-v3-multi.expected.json:19`, `compile-v1-legacy.expected.json:9`, `compile-v2-agents.expected.json:9` (`.kortix/opencode` → `.opencode`)
- Modify: `apps/web/src/features/workspace/customize/sections/view/runtime-view.test.tsx:113,205,215` (placeholder assertions)
- Test: existing suites only.

**Interfaces:**
- Consumes: Task 1's descriptor value.
- Produces: `DEFAULT_OPENCODE_CONFIG_DIR === '.opencode'`; `resolveOpencodeDir(null)` returns `.opencode`.

- [ ] **Step 1: Update `manifest.test.ts` expectations from `.kortix/opencode` to `.opencode` (RED)** — explicit `config_dir` cases keep their explicit values; only default-fallback expectations change.
- [ ] **Step 2: Run** `pnpm --filter @kortix/registry test` — expected FAIL.
- [ ] **Step 3:** In `packages/registry/src/manifest.ts:13` set `export const DEFAULT_OPENCODE_CONFIG_DIR = '.opencode';`
- [ ] **Step 4: Run** `pnpm --filter @kortix/registry test` — PASS.
- [ ] **Step 5:** Update the three compile fixture JSONs and the web runtime-view test placeholders, then run `pnpm --filter @kortix/api test -- compile-runtime-config` and `pnpm --filter web test -- runtime-view runtime-profile-options` — PASS. (`runtime-profile-options.test.ts` asserts equality with `HARNESSES[id].configDir`, so it self-heals.)

### Task 3: legacy fallback — sandbox and API scanner

**Files:**
- Modify: `apps/kortix-sandbox-agent-server/src/acp/harness-registry.ts:84-98` (`nativeConfigDir`)
- Modify: `apps/api/src/projects/git/config.ts:219-233` (`discoverRuntimeProjectFiles` region)
- Test: co-located tests next to each (follow each file's existing test file conventions)

**Interfaces:**
- Consumes: `KORTIX_RUNTIME_CONFIG_DIR`/`KORTIX_WORKSPACE` env (sandbox); compiled profile `configDir` + git tree listing (API).
- Produces: the fallback rule — *if the resolved OpenCode dir lacks `opencode.jsonc` and `.kortix/opencode/opencode.jsonc` exists, resolve to `.kortix/opencode`* — implemented identically in both places. Rule applies only to `opencode`.

- [ ] **Step 1: Sandbox failing test.** In the harness-registry test file, with a temp workspace dir:

```ts
test('opencode config dir falls back to legacy .kortix/opencode when new default is absent', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'kortix-ws-'));
  await mkdir(join(ws, '.kortix/opencode'), { recursive: true });
  await writeFile(join(ws, '.kortix/opencode/opencode.jsonc'), '{}');
  const env = nativeConfigEnv('opencode', {
    KORTIX_WORKSPACE: ws,
    KORTIX_RUNTIME_CONFIG_DIR: '.opencode',
  });
  expect(env.OPENCODE_CONFIG_DIR).toBe(join(ws, '.kortix/opencode'));
});

test('opencode config dir stays on the configured dir when it has opencode.jsonc', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'kortix-ws-'));
  await mkdir(join(ws, '.opencode'), { recursive: true });
  await writeFile(join(ws, '.opencode/opencode.jsonc'), '{}');
  await mkdir(join(ws, '.kortix/opencode'), { recursive: true });
  await writeFile(join(ws, '.kortix/opencode/opencode.jsonc'), '{}');
  const env = nativeConfigEnv('opencode', {
    KORTIX_WORKSPACE: ws,
    KORTIX_RUNTIME_CONFIG_DIR: '.opencode',
  });
  expect(env.OPENCODE_CONFIG_DIR).toBe(join(ws, '.opencode'));
});
```

Adapt the call signature to `nativeConfigEnv`'s real one (read the file first — if it reads `process.env` directly, inject via the test's env-stubbing pattern already used in that suite). If the current functions are sync, use sync `fs` in both test and implementation.

- [ ] **Step 2: Run** the sandbox-agent-server suite for that file — expected FAIL (no fallback yet).
- [ ] **Step 3: Implement** in `nativeConfigDir()`: after resolving the dir against `KORTIX_WORKSPACE`, for harness `opencode` only:

```ts
if (harness === 'opencode' && !existsSync(join(dir, 'opencode.jsonc'))) {
  const legacy = join(workspace, '.kortix/opencode');
  if (existsSync(join(legacy, 'opencode.jsonc'))) return legacy;
}
```

Match the file's import style (`node:fs`, `node:path`). The check must run before `ensureHarnessConfigDirs` mkdirs anything (it does — registry resolves env before `runtime.ts` consumes it; verify by reading the call order in `runtime.ts:44-89`).

- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: API scanner failing test.** In `config.ts`'s test file, using its existing fake-git-tree fixture pattern: a tree with `.kortix/opencode/opencode.jsonc` and no `.opencode/`, profile configDir `.opencode` → `discoverRuntimeProjectFiles` finds the config and `hasNativeConfig` is true; a tree with both → `.opencode` wins.
- [ ] **Step 6: Run** — FAIL, **Step 7: implement** the same rule against the tree listing (string membership, not fs), **Step 8: run** — PASS.

### Task 4: sandbox Dockerfile layer + snapshot builders

**Files:**
- Modify: `packages/shared/src/sandbox/dockerfile-layer.ts` — every `.kortix/opencode` literal: lines 82, 270, 301, 313, 326, 329, 336-339, 366, 673 (`/workspace/.kortix/opencode` → `/workspace/.opencode`, warm-config staging dir → `/opt/kortix/warm-config/.opencode/`, `mkdir -p /workspace/.kortix` drops where it existed only for opencode, cleanup `rm -rf /workspace/.opencode` and keep the `.kortix` rmdir only if still needed by other content — read the surrounding block)
- Modify: `apps/api/src/snapshots/build-context.ts:50-51,158-161,194,243-254` (starter source path → `packages/starter/templates/base/.opencode`)
- Modify: `apps/api/src/snapshots/dockerfile-layer.ts:124,177,449`
- Test: `packages/shared/src/sandbox/__tests__/layer-render.test.ts:203` + regenerated snapshot; apps/api snapshot-builder suite.

**Interfaces:**
- Consumes: Task 6's physically moved starter trees (do Task 6 first or in the same worktree session — the build-context path must point at a dir that exists).
- Produces: rendered Dockerfiles exporting `OPENCODE_CONFIG_DIR=/workspace/.opencode` and staging warm config there.

- [ ] **Step 1:** Update the explicit assertion at `layer-render.test.ts:203` to the new path (RED), run `pnpm --filter @kortix/shared test -- layer-render` — FAIL.
- [ ] **Step 2:** Sweep `dockerfile-layer.ts` literals (search `.kortix/opencode` — 12+ hits; also search `.kortix` alone and keep non-opencode uses like memory untouched).
- [ ] **Step 3:** Regenerate the snapshot via the runner's update mode, diff it — only opencode-path lines change. Run — PASS.
- [ ] **Step 4:** Update both apps/api snapshot files, run the api snapshots suite — PASS.

### Task 5: starter templates + managed skills + schema docs + web copy

**Files:**
- Move: `packages/starter/templates/base/.kortix/opencode/` → `packages/starter/templates/base/.opencode/` (same for `marketplace/`, `general-knowledge-worker/`, `marketplace-projects/web-studio/`) via `git mv`
- Modify: `packages/starter/scripts/write-managed-skills.ts:18` (`SKILLS_PREFIX = '.opencode/skills/'`)
- Modify: `packages/manifest-schema/src/json-schema.ts:154,165,227,585`, `index.v2.ts:105,132,408`, `README.md:30`, validator tests (`validator.v2.test.ts:75,144`, `validator.v3.test.ts:21`) — default/doc strings only; explicit-value test cases stay
- Modify: `apps/web/src/features/workspace/customize/use-configure-thread.ts:28,32,35` (user-facing strings → `.opencode/...`)
- Modify: `packages/shared/README.md:78,253` harness matrix; `apps/cli/README.md:11,53`
- Test: existing suites.

- [ ] **Step 1:** `git mv` the four trees (verify with `git status` that renames are tracked, not delete+add of content).
- [ ] **Step 2:** Sweep the listed literals; then repo-wide `rg -l '\.kortix/opencode'` and triage every remaining hit: it must be either (a) a deliberate legacy-fallback reference from Task 3/7, (b) a historical doc/changelog entry — leave those, or (c) a miss — fix it.
- [ ] **Step 3:** Run `pnpm --filter @kortix/starter test`, `pnpm --filter @kortix/manifest-schema test`, `pnpm --filter web test -- use-configure-thread` — PASS.

### Task 6: CLI rewire

**Files:**
- Modify: `apps/cli/src/agents.ts` (lines 11, 14, 20-38, 72-73), `apps/cli/src/commands/init.ts:26,28,30,66,219,297`, `apps/cli/src/commands/skills.ts:76,238`
- Test: the CLI's existing agents/init/skills test files.

**Interfaces:**
- Produces: `CANONICAL_SKILL = '.opencode/skills/kortix-system/SKILL.md'`; `OPENCODE_DIR = '.opencode'`; `AGENT_LINK` drops the `opencode` entry (the real dir needs no self-link); `.claude` and `.agents` symlink to `.opencode`; `wireCodingAgents` replaces a pre-existing `.opencode` symlink (legacy scaffold pointing at `.kortix/opencode`) so the real dir can take its place — a real `.opencode` directory is left alone.

- [ ] **Step 1: Failing tests** in the agents test file:

```ts
test('wireCodingAgents links claude and agents dirs to .opencode and skips opencode self-link', () => {
  const root = mkdtempSync(join(tmpdir(), 'kortix-cli-'));
  mkdirSync(join(root, '.opencode'), { recursive: true });
  const result = wireCodingAgents({ repoRoot: root, agents: ['opencode', 'claude', 'codex'], overwrite: false });
  expect(existsSync(join(root, '.claude'))).toBe(true);
  expect(readlinkSync(join(root, '.claude'))).toBe('.opencode');
  expect(readlinkSync(join(root, '.agents'))).toBe('.opencode');
  expect(lstatSync(join(root, '.opencode')).isSymbolicLink()).toBe(false);
  expect(result.written).not.toContainEqual(expect.stringContaining('.opencode →'));
});

test('wireCodingAgents removes a legacy .opencode symlink', () => {
  const root = mkdtempSync(join(tmpdir(), 'kortix-cli-'));
  mkdirSync(join(root, '.kortix/opencode'), { recursive: true });
  symlinkSync('.kortix/opencode', join(root, '.opencode'));
  wireCodingAgents({ repoRoot: root, agents: ['opencode'], overwrite: false });
  expect(lstatSync(join(root, '.opencode')).isSymbolicLink()).toBe(false);
});
```

(Second test's expected end-state: the legacy symlink is removed; scaffolding the real dir is `init`'s job — assert per how `init.ts` composes `wireCodingAgents`, read it first and adjust the assertion to the real seam.)

- [ ] **Step 2: Run** — FAIL. **Step 3: Implement** per the Produces block, updating the `AGENT_LINK` doc comment to the new topology. **Step 4: Run** the full CLI suite — PASS.

### Task 7: end-to-end sweep — flows, probes, docs

**Files:**
- Modify: `tests/src/flows/cli-local.flow.ts:57-60,124,130`; `tests/e2e/scripts/memory-tool-opencode-e2e.sh:5,25`; `tests/performance/session-start/oclog-probe.mjs:4`
- Test: these ARE tests.

- [ ] **Step 1:** Update paths in the three files. `oclog-probe.mjs` greps opencode's log line `loading <workspace>/.kortix/opencode/opencode.jsonc` — make its pattern accept both `\.opencode` and the legacy path so it works across old and new sandboxes: `/(\.opencode|\.kortix\/opencode)\/opencode\.jsonc/`.
- [ ] **Step 2:** Run the cli-local flow and the opencode e2e script per their headers. PASS.
- [ ] **Step 3: Phase gate** — full monorepo check: `pnpm -r typecheck && pnpm -r test` (plus `rg '\.kortix/opencode'` triage from Task 5 re-run). Report results to Jay; **do not commit**.

---

## Phase 2 — model-connect UX (own worktree; load `kortix-design-system` + `make-interfaces-feel-better` first)

### Task 8: SDK — `connectedProviderIds` joins the `useModelsPage` projection

**Files:**
- Modify: `packages/sdk/src/react/use-models-page.ts`
- Test: its co-located test file.

**Interfaces:**
- Consumes: the projection's existing inputs (`useHarnessConnections`, catalog) plus the secret-name derivation currently living web-side (`connectedGatewayProviderIdsFromSecretNames`, imported today by `apps/web/.../model-selector.tsx:189` region).
- Produces: `ModelsPageState` gains `connectedProviderIds: readonly string[]` (additive). The secret-name→provider-id derivation moves into the SDK next to the projection (framework-free helper, exported).

- [ ] **Step 1:** Port `connectedGatewayProviderIdsFromSecretNames` into the SDK with its web tests (copy the existing web test cases so behavior is pinned before the move).
- [ ] **Step 2:** Failing test — `useModelsPage` state includes `connectedProviderIds` derived from the project secrets it already has access to (if it does not currently fetch secrets, add the fetch here — one place — using the same SDK client call the web uses, `listProjectSecrets`).
- [ ] **Step 3:** Implement; run SDK gates (`typecheck && test && smoke:install`); surface-snapshot diff must be additive only.
- [ ] **Step 4:** Consolidate the copy maps: move `CONNECTION_NAME`-adjacent strings currently duplicated in `apps/web/.../connection-row.tsx`, `connection-select.tsx`, `manage-connection-modal.tsx` (incl. the reconnect-verb map at `manage-connection-modal.tsx:202-206`) into exported constants in `use-models-page.ts`; web files import them. Delete the "these must agree" comments — they now can't disagree. Run web + SDK suites.

### Task 9: one connect surface — root-mounted modal, single `openConnectProvider` behavior

**Files:**
- Create: `apps/web/src/features/workspace/customize/sections/llm-provider/connect-modal-host.tsx` (~60 lines: zustand store `{ open, tab, connectKind, providerId }` + a component rendering `ConnectModelModal` once, mounted in the app shell next to the existing global `provider-modal-store` host — read how that one is mounted and mirror it)
- Modify: `apps/web/src/features/session/use-model-connection-gate.tsx:103-123` — delete the three-way branch; `openConnectProvider(tab, opts)` now only sets the store
- Modify: `apps/web/src/features/workspace/customize/sections/llm-provider/models-view.tsx` — its Connect button uses the same store; drop the locally-hosted `ConnectModelModal`
- Delete (after migration): the gateway-off `ProjectProviderModal` mount inside `use-model-connection-gate.tsx`; the `openCustomize('llm-providers', …)` deep-link path from the composer gate (Customize keeps its own nav entry — only the composer stops routing there)
- Test: gate hook test + a `connect-modal-host` render test; run the whitelabel/e2e suites that exercise connect.

**Interfaces:**
- Produces: `useConnectModal()` → `{ open(opts: { tab?: 'subscriptions' | 'api-keys'; providerId?: string; connectKind?: string }): void; close(): void }`. Every connect CTA in the app calls this and nothing else.

- [ ] **Step 1:** Failing hook test: `openConnectProvider` in a project with gateway ON no longer calls `openCustomize` (spy) and instead opens the store.
- [ ] **Step 2:** Build the store + host; mount once; migrate the three call paths.
- [ ] **Step 3:** Run web suite + `tsc`; manually verify (worktree stack, Mailpit login per memory recipe): connect from composer gate, from Models view, and from outside a project all open the identical modal.

### Task 10: Claude subscription form — stepper parity with ChatGPT

**Files:**
- Modify: `apps/web/src/features/workspace/customize/sections/llm-provider/forms/claude-subscription-form.tsx` (118 lines today)
- Test: its co-located test.

**Interfaces:**
- Consumes: existing secret write (`CLAUDE_CODE_OAUTH_TOKEN`) + `UseWithRuntimes`.
- Produces: same submit contract; new two-step UI.

- [ ] **Step 1:** Read `chatgpt-subscription-form.tsx` (209 lines) and `dev-view.tsx`'s `Stepper` usage; mirror their shell.
- [ ] **Step 2:** Step 1 of the form: explanation line (`text-sm text-muted-foreground`), command block with `claude setup-token` + copy button using the canonical icon-swap morph (copy `CopyButton` pattern from `unified-markdown.tsx` — scale 0.25→1, blur 4px→0, spring `{ type: 'spring', duration: 0.3, bounce: 0 }`), docs link (`Button variant="transparent" size="sm" asChild`). Step 2: password input (unchanged validation ≥20 chars, live "looks like a token" hint via `FieldDescription`), `UseWithRuntimes`, submit with `Loading className="size-4 shrink-0"`, `successToast` on connect.
- [ ] **Step 3:** Component test: step advance, paste-validation states, submit calls the same mutation as before (pin with a spy before refactoring). Run — PASS.

### Task 11: unified picker becomes the only picker

**Files:**
- Modify: wherever `experimental.unified_model_picker` defaults (found via `rg unified_model_picker apps/api` — flip the server default to on; keep the flag readable for one release as a kill switch)
- Modify: `apps/web/src/features/session/session-chat-input.tsx:2544-2586` — delete the legacy branch; always render `ModelPicker`
- Modify: `apps/web/src/features/session/model-picker/model-picker.tsx` + `model-picker-row.tsx` — carry over the e2e testids (`data-testid="harness-model-selector"` on the trigger, `agent-option`, `data-harness`) and any legacy-only features the parity pass finds (activation switches, "Automatic" row, set-as-default footer, `Tag variant="free"`, custom-model entry, subscription "managed by" note)
- Delete (once parity + e2e are green): `model-selector.tsx` (602), `harness-model-selector.tsx` (280), their helper files' now-dead exports; `composer-chat-input.tsx` drops the fork wiring (`nativeHarness` branch)
- Note: the duplicate default-model `ModelSelector` floating in the LLM tab bar (`apps/web/src/features/workspace/customize/sections/gateway-view.tsx:121-139`) is NOT removed here — Task 17 relocates it into `ModelsView` as the labeled "Default model" row; leave it in place until then
- Test: parity checklist as component tests on `ModelPicker`; `14-acp-harness-selector.spec.ts` unmodified.

- [ ] **Step 1: Parity audit first.** Read all three pickers end to end; table every behavior of the two legacy pickers vs `ModelPicker`/`useModelPicker`. Anything missing lands in `ModelPicker` with a component test BEFORE the legacy delete. Known-suspect list: per-model activation switches, set-as-default (account/project/agent) footer, empty-state CTAs, search gating by `usableModelCount`, custom model free-text (`model.custom_allowed`), live-session option derivation in `composer-chat-input.tsx`.
- [ ] **Step 2:** Flip the flag default (API test asserting the default), run the e2e spec against the worktree stack — PASS before any deletion.
- [ ] **Step 3:** Delete the legacy fork + files; `rg 'HarnessModelSelector|from.*model-selector'` must come back empty (back-compat re-export `ConnectProviderDialog` in `model-selector.tsx` moves to its real home before the delete).
- [ ] **Step 4:** Full web suite + `tsc` + e2e spec — PASS.

### Task 12: not-connected picker state

**Files:**
- Modify: `apps/web/src/features/session/model-picker/model-picker.tsx` (+ a new `connect-prompt.tsx` ~80 lines beside it)
- Modify: the pill trigger (in `composer-pill.ts` consumers) for the attention state
- Test: component tests.

**Interfaces:**
- Consumes: `useModelsPage().connectedProviderIds` (Task 8), `HARNESSES[harness].authKinds` (from the SDK harness mirror), `useConnectModal()` (Task 9).
- Produces: when the active agent's harness has no usable connection: trigger shows `size-1.5 rounded-full bg-kortix-orange` dot + "Connect a model" label; popover body renders `ConnectPrompt` — provider rows (`ProviderLogo` `size-4`, name `text-sm font-medium`, hint `text-xs text-muted-foreground`, whole row a 40px-min-height button) ordered by the harness's `authKinds`, max 4, then a "More options…" row; every row calls `useConnectModal().open({ providerId })`.

- [ ] **Step 1:** Failing component test: picker with zero connections for harness `claude` renders rows for Claude subscription + Anthropic API key (order per `authKinds`), and clicking one opens the connect store with that provider preselected.
- [ ] **Step 2:** Implement; rows use `CommandItem` styling for keyboard nav consistency; popover keeps `shadow-md`, origin-aware transform, 150–200ms ease-out.
- [ ] **Step 3:** After a successful connect, the popover's list refreshes in place (react-query invalidation from the modal's mutation — verify the queries share keys via `useModelsPage`; add the invalidation if the modal doesn't already trigger it). Component test with a mocked mutation round-trip.
- [ ] **Step 4:** Wire `ModelConnectionBar`'s actions through `useConnectModal()` too (it already computes reasons; only its click handlers change). Run suite.

### Task 13: composer extraction — `AgentSelector` and model controls out of the monolith

**Files:**
- Create: `apps/web/src/features/session/agent-selector.tsx` (move `session-chat-input.tsx:259-485` verbatim)
- Create: `apps/web/src/features/session/composer-model-controls.tsx` (move the toolbar block, post-Task-11 shape)
- Modify: `apps/web/src/features/session/session-chat-input.tsx` — imports the two; net line count drops by ~350+
- Test: existing composer tests keep passing unchanged (mechanical move); add render tests for the two new files.

- [ ] **Step 1:** Move `AgentSelector` + its local helpers/types; export only what the composer consumes. No behavior change — `git diff` on the moved block should show path-only changes.
- [ ] **Step 2:** Same for the model-controls block (ModelPicker + VariantSelector + ReasoningEffortSelector row).
- [ ] **Step 3:** `pnpm --filter web test` + `tsc` + e2e spec — PASS.

### Task 14: agent selector polish — harness grouping + connection status

**Files:**
- Modify: `apps/web/src/features/session/agent-selector.tsx`, `agent-selector-helpers.ts` (`shouldGroupAgentsByHarness`)
- Test: helper + component tests.

**Interfaces:**
- Consumes: `useModelsPage().runtimes` (per-harness connection status), existing agent list.
- Produces: groups always render with harness header labels when agents span >1 harness (unchanged threshold, but headers become `CommandGroup` headings with `HarnessIcon size-3.5` + label, `text-xs text-muted-foreground`); each agent row gains a trailing `size-1.5 rounded-full bg-kortix-orange` dot (+ `Hint label="No model connected"`) when its harness's runtime status is not connected; locked state and `Tab` cycling unchanged.

- [ ] **Step 1:** Failing component test: two harnesses, one disconnected → its agents show the dot, connected one doesn't; single-harness project → no group headers (existing behavior pinned).
- [ ] **Step 2:** Implement. Dot is presentational only — selection still allowed (the picker's Task-12 state takes over after selection).
- [ ] **Step 3:** Run suite.

### Task 15: polish pass + e2e for the connect path — **execute LAST, after Tasks 16-22**

**Files:**
- Touched surfaces from Tasks 9-14 and 16-22
- Create: `tests/e2e/specs/**` new spec `connect-model-from-picker.spec.ts` (number it per the dir's convention)
- Test: the pass itself.

- [ ] **Step 1:** Run the `make-interfaces-feel-better` review checklist over every touched file; present the Before/After tables it mandates. Specifically verify: no `transition: all`, `AnimatePresence initial={false}` everywhere, hit areas ≥40px in the connect prompt and method list, `tabular-nums` on model counts, concentric radii in the modal (outer `rounded-md`+, inner controls per token table).
- [ ] **Step 2:** Design-system audit: `rg -n 'Loader2|from.*ui/tooltip|ui/dialog|@/lib/toast' apps/web/src/features/session apps/web/src/features/workspace/customize/sections` → zero hits in touched files; no raw palette classes.
- [ ] **Step 3: Copy/glossary triage** (spec 3c): `rg -n '\bLLM\b|gateway|harness|runtime|endpoint|manage-keys' apps/web/src/features/workspace/customize/sections apps/web/src/features/session` — every hit is either (a) code identifiers/comments, (b) a Developer-surface string sanctioned by the glossary, or (c) a miss to fix. Also grep for `font-mono` near model ids outside Developer surfaces.
- [ ] **Step 4:** New e2e: seed a project with no connections → composer pill shows "Connect a model" → popover prompt → modal → API-key form (fake key via test secrets seam) → picker shows models without reload. Follow the worktree authed-Playwright recipe (memory: cookie trick). Assert the Customize rail shows "Models" and its landing view renders the "Kortix models are included" state for the seeded project.
- [ ] **Step 5: Phase gate** — full web suite, `tsc`, both e2e specs, SDK gates. Report to Jay; **do not commit**.

### Task 16: Models section IA — 3 tabs, rail rename, dead deep-link deleted

**Files:**
- Modify: `apps/web/src/features/workspace/customize/sections/gateway-view.tsx` (`LLM_TABS` at 43-55, `TAB_BY_SECTION` at 57-65, tab bar 113-140, contents 144-204)
- Modify: `apps/web/src/features/workspace/customize/customize-panel.tsx:46` (rail label `'LLM'` → `'Models'`)
- Modify: `apps/web/src/features/workspace/customize/customize-store.ts:21` (delete `LlmProvidersTab` type + `llmProvidersTab` field + setter)
- Modify: `apps/web/src/features/session/use-model-connection-gate.tsx:109-112` (drop the `llmProvidersTab` write; note: after Task 9 this path only opens the connect modal — if Task 9 already landed, this is just dead-type cleanup)
- Modify: `apps/web/src/features/workspace/customize/sections/llm-provider/llm-provider-modal.tsx:13-17` (remove the accepted-and-ignored `defaultTab`/`allowedTabs` props)
- Test: `gateway-view` render test + `customize-store` test file.

**Interfaces:**
- Consumes: existing tab components unchanged (`ModelsView`, `GatewayOverview`, `GatewayLogs`, `GatewayBudgets`, `GatewayRouting`, `GatewayPlayground`, `GatewayKeys`, `GatewayApiReference`).
- Produces: `LLM_TABS = [{ id: 'models', label: 'Models' }, { id: 'usage', label: 'Usage' }, { id: 'developer', label: 'Developer' }]`; Usage and Developer each render a `TabsListCompact` sub-row (`Overview · Activity · Limits` and `Routing · Playground · API access`) with local sub-tab state; `TAB_BY_SECTION` maps `llm-overview|llm-logs|llm-budgets` → `usage` (+ matching sub-tab) and `llm-keys|llm-api` → `developer` (+ `api`).

- [ ] **Step 1: Failing tests.** Render test: `LlmManagementView` shows exactly 3 top-level tabs labeled Models/Usage/Developer, defaults to Models; deep-link test: seeding the store section `llm-logs` lands on Usage with the Activity sub-tab active. Store test: `llmProvidersTab` no longer exists (type-level: the test file stops importing it — the deleted-field assertion is `tsc` itself).
- [ ] **Step 2:** Implement the regroup. Sub-rows use `TabsListCompact`/`TabsTriggerCompact` (pattern: `changes-view.tsx`). The top bar keeps only the tab list — the floating `ModelSelector` stays where it is until Task 17 relocates it (do not delete it here).
- [ ] **Step 3:** Delete the `llmProvidersTab` plumbing end to end; `rg -n 'llmProvidersTab|LlmProvidersTab' apps/web` → zero hits. Keep `llmProvidersConnect`.
- [ ] **Step 4:** Run `pnpm --filter web test -- gateway-view customize-store use-model-connection-gate` + `tsc` — PASS.

### Task 17: "you're set" landing view — default-model row, Kortix pinned, honest empty state

**Files:**
- Modify: `packages/sdk/src/react/use-models-page.ts` (`connectionRank`; new exported copy constants)
- Modify: `apps/web/src/features/workspace/customize/sections/llm-provider/models-view.tsx` (new first section; empty state; "Manage agents →" relabel at line 76/133-136)
- Modify: `apps/web/src/features/workspace/customize/sections/gateway-view.tsx` (remove the tab-bar `ModelSelector` block at 121-139 — its relocation target now exists)
- Test: `use-models-page` co-located test; `models-view` render test.

**Interfaces:**
- Consumes: `useModelDefaults` (unchanged write path), `useModelsPage`, `ModelSelector`/unified picker trigger as-is.
- Produces: SDK exports (additive) `KORTIX_INCLUDED_TITLE = 'Kortix models are included'` and `CONNECTIONS_OPTIONAL_DESCRIPTION = 'Optionally connect a Claude or ChatGPT subscription, or your own API key, to use those instead.'`; `connectionRank` orders: needs-attention first, then ready `managed_gateway`, then in-use BYOK, then the rest (pin existing order with a test before changing).

- [ ] **Step 1: SDK failing tests.** `connectionRank`: a ready managed-gateway connection sorts above a ready BYOK connection; a needs-attention BYOK still sorts above the managed row. Copy constants exported with the exact strings above.
- [ ] **Step 2:** Implement in `use-models-page.ts`; run SDK gates (`typecheck && test && smoke:install`); surface-snapshot diff additive only.
- [ ] **Step 3: Web failing test.** `ModelsView` renders a "Default model" `Label` + bordered row (`bg-popover rounded-md border px-4 py-3`, description "Used when an agent doesn't pick its own" left, selector right) as its first section; with zero user connections and a healthy managed gateway, the empty state renders `KORTIX_INCLUDED_TITLE` + `CONNECTIONS_OPTIONAL_DESCRIPTION` with the Connect CTA; with the managed gateway unavailable, the legacy "No model services connected yet" framing renders instead; the cross-link reads "Manage agents →".
- [ ] **Step 4:** Implement; move the default-model control out of `gateway-view.tsx`'s tab bar into this section (same `useModelDefaults` wiring — a mechanical relocation, pin with the existing default-model test if one exists, else add one).
- [ ] **Step 5:** Run web suite + `tsc` — PASS.

### Task 18: merged "API access" panel

**Files:**
- Create: `apps/web/src/features/workspace/customize/sections/view/gateway/gateway-api-access.tsx` (~40 lines: `GatewayKeys` on top, `GatewayApiReference` below, one scroll container; match the dir's actual layout — read `gateway-view.tsx:174-204` first)
- Modify: `apps/web/src/features/workspace/customize/sections/gateway-view.tsx` (Developer sub-tab `api` renders the merged panel; delete the separate keys/api contents and the inline "Call the gateway" block, folding its heading into the merged panel)
- Modify: `gateway-keys.tsx` + `gateway-api-reference.tsx` — delete the `onViewModels`/tab-hop props and the "Create a key" cross-tab link (now an in-panel anchor/scroll)
- Test: render test for the merged panel.

- [ ] **Step 1: Failing test.** Developer → API access renders both the keys table and the API reference in one panel; no `onViewModels` prop remains (`rg -n 'onViewModels' apps/web` → zero).
- [ ] **Step 2:** Implement; heading copy for the reference block becomes "Use these models from your code" (spec 3c — "Call the gateway" drops the g-word; Developer-surface body copy may keep "gateway" where precise).
- [ ] **Step 3:** Run web suite + `tsc` — PASS.

### Task 19: gateway tab error/loading standardization

**Files:**
- Modify: `apps/web/src/features/workspace/customize/sections/view/gateway/gateway-overview.tsx` (~51-55), `gateway-budgets.tsx`, `gateway-logs.tsx` (incl. `rounded-2xl` skeletons at ~226-227 → `rounded-md`), `gateway-keys.tsx:70-78`
- Test: each file's co-located/render test.

**Interfaces:**
- Produces: every tab follows Skeleton → `ErrorState size="sm"` + Retry → `EmptyState size="sm"` → content (the `agents-view.tsx` flow). Keys 403 → `ErrorState` title "API keys need admin access", description "Ask a project admin.", no retry; other errors → "Couldn't load API keys" + Retry.

- [ ] **Step 1: Failing tests.** For each of Overview/Budgets/Logs: mock the query into `isError` → an `ErrorState` with a Retry button renders and clicking it calls `refetch` (today: asserts would find zeros/empty rendered as truth). For Keys: 403 → the admin-access copy with no permission-name leak; 500 → generic + Retry.
- [ ] **Step 2:** Implement the branches; no new primitives.
- [ ] **Step 3:** Run web suite + `tsc` — PASS.

### Task 20: delete `VariantSelector`

**Files:**
- Modify: `apps/web/src/features/session/session-chat-input.tsx` (component at 493-535; render at 2573-2585; prop threading at 114, 193, 1290-1292, 1419; StartStash variant field)
- Modify: `apps/web/src/features/session/composer-chat-input.tsx:521-526` (drop the `variants` wiring + comment)
- Modify: translations: remove the `line322JsxTextCycleThinkingEffort` key (`en.json:5529`) and its siblings in other locales
- Test: existing composer tests (must keep passing — the control renders nothing for models.dev models today, so no visual regression is expected).

**Interfaces:**
- Consumes: nothing after removal. SDK's `use-model-store` variant persistence and `use-runtime-local` `cycleVariant` are public API — leave them in place (deprecation is the SDK cycle's call), only the web control and its prop chain go.

- [ ] **Step 1:** Delete the component + threading; `rg -n 'VariantSelector|selectedVariant|onVariantChange|cycleVariant' apps/web/src` → zero hits (SDK hits are fine).
- [ ] **Step 2:** Run web suite + `tsc` + e2e selector spec — PASS, no snapshot/count regressions.

### Task 21: "Thinking" pill (reasoning effort redesign)

**Files:**
- Modify: `apps/web/src/features/session/reasoning-effort-selector.tsx` (trigger 173/184-190, popover 192-239, tooltips 207-213)
- Test: its co-located test.

**Interfaces:**
- Consumes: existing `useGatewayRoutingPolicy` write path (unchanged — pin with a spy test before touching presentation); `displayModel()` from the gateway `_shared` helpers; `COMPOSER_PILL_TRIGGER_CLASS`/`ACTIVE`/`DISABLED` from `composer-pill.ts`; `Hint`.
- Produces: trigger = shared pill classes + `Brain` icon + value, unset state labeled **"Auto"**; popover heading "Thinking level", first item **"Auto — model default"**; footer `border-t px-2 py-1.5 text-xs text-muted-foreground` reading `Applies to {displayModel(wireModel)} everywhere in this project.`; locked `Hint`: "Only editors can change this."; no `font-mono` wire id anywhere.

- [ ] **Step 1: Failing tests.** Unset state renders "Auto" in the trigger AND "Auto — model default" as the first item; footer shows the display name (assert the mono wire id is absent); mutation payload unchanged (spy); trigger class list contains the shared constant's press-scale (`active:scale-[0.96]`).
- [ ] **Step 2:** Implement; `Tooltip` → `Hint` migration included.
- [ ] **Step 3:** Run web suite + `tsc` — PASS.

### Task 22: ACP config options — shared classes, mode segments, extraction

**Files:**
- Create: `apps/web/src/features/session/acp-config-option-pills.tsx` (move `AcpConfigOptionPill` from `acp-session-chat.tsx:923-990`; add `AcpConfigOptionSegment`)
- Modify: `apps/web/src/features/session/acp-session-chat.tsx:476-486` (filter widen `select` → `select || mode`; render fork by type in `toolbarSlot` at 805-817)
- Modify: `apps/web/src/features/session/composer-pill.ts` (doc comment gains the pill law from spec 3d)
- Test: new co-located `acp-config-option-pills.test.tsx` + the existing `acp-session-chat` test.

**Interfaces:**
- Consumes: ACP `configOptions` (`type: 'select' | 'mode'`, `options: [{ id, label }]`, current value), `setConfigOption` from the session (optimistic + `Loading` + revert-on-error semantics per the 07-14 design's B1 — reuse whatever the pill already does).
- Produces: `AcpConfigOptionPill({ option, onChange, disabled })` unchanged in behavior but on the shared pill constants; `AcpConfigOptionSegment({ option, onChange, disabled })` — `TabsListCompact`/`TabsTriggerCompact` segmented control on the h-8 baseline, one trigger per option choice, active choice from the option's current value.

- [ ] **Step 1: Failing tests.** A `mode`-typed option with 3 choices renders a segmented control (today: renders nothing — pin that with the widened-filter test); a `select`-typed option still renders the popover pill; pill trigger class contains the shared constant (press-scale present); segment click calls `setConfigOption` with the choice id and shows `Loading` while in flight.
- [ ] **Step 2:** Extract + implement; the fork in `toolbarSlot` is `option.type === 'mode' ? <AcpConfigOptionSegment/> : <AcpConfigOptionPill/>`.
- [ ] **Step 3:** Write the pill law into `composer-pill.ts`'s header comment (shared constants mandatory; chevron ⇔ popover; click-to-cycle banned; hide vs disable-with-Hint policy).
- [ ] **Step 4:** Run web suite + `tsc` + e2e selector spec — PASS.

---

## Self-review notes

- Spec coverage: Part 1 table → Tasks 1-7; 2a → Task 11; 2b → Task 12; 2c → Task 9; 2d → Task 10; 2e → Tasks 8 + 17 (default-model dedup moved from Task 11 to Task 17's relocation); 2f → Tasks 13-14; 3a → Task 16; 3b → Task 17; 3a's API-access merge → Task 18; 3e → Task 19; 3d → Tasks 20-22; 3c + 2g → Task 15 (glossary triage + polish, runs last). Execution order: 1-7 (Phase 1), then 8 → 9/10 → 16-19 (independent of picker work, after 8) → 11 → 12 → 13-14 → 20-22 → 15.
- Line anchors: cited from the 2026-07-20 survey; every task's first action is to read the target region, so drift is caught before editing.
- The Task 3 / Task 6 test snippets assume the neighboring suites' existing temp-dir and env-injection idioms; implementers adapt call signatures to what the file actually exports (both tasks say to read first). The behavioral assertions are the contract.
