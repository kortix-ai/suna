# `@kortix/shared`

Shared TypeScript code for Kortix frontend and backend applications
(utilities, error classes, tool metadata, runtime version pins, and the
harness descriptor). This README documents one module in depth: **the
harness descriptor** (`src/harnesses.ts`) — the single source of truth for
which coding-agent harnesses Kortix supports and what each one can do.

## The harness descriptor

`HARNESSES` (`packages/shared/src/harnesses.ts`) is a `Record<HarnessId,
HarnessDescriptor>` keyed by the four supported harness ids —
`HARNESS_IDS = ['claude', 'codex', 'opencode', 'pi']`. It is the **single
source of truth** for harness identity, capability, and stability across the
platform: `manifest-schema`, `apps/api`, `apps/web`, `@kortix/sdk`, and the
sandbox agent server all derive their harness knowledge from this module. No
other file redeclares the harness id tuple, labels, config directories,
adapter package names, or the auth-kind matrix (`packages/shared/src/harnesses.ts:1-15`,
its own top-of-file doc comment).

### Fields

Each `HarnessDescriptor` (`packages/shared/src/harnesses.ts:37-55`) has:

| Field | Meaning |
|---|---|
| `id` | The canonical `HarnessId` (`'claude' \| 'codex' \| 'opencode' \| 'pi'`). |
| `label` | Display label shown in the UI, e.g. `"Claude Code"`. |
| `configDir` | The harness's native config directory, relative to the project root (e.g. `.claude`). |
| `adapterPkg` | The npm package name for the harness's ACP adapter (or the harness's own package, for OpenCode). |
| `stability` | `'stable' \| 'experimental'`. Drives the `experimental_harnesses` feature gate — see below. |
| `modelNamespacing` | `'gateway-prefixed' \| 'bare'`. Whether a `kortix/`-prefixed gateway model id must be stripped before reaching the harness. |
| `ownsDefaultModel` | Whether the harness supplies its own default model without an explicit launch override (true for Claude/Codex/Pi; false for OpenCode). |
| `liveModelChange` | Whether the model can be changed live, mid-session (true only for OpenCode today). |
| `authKinds` | The `HarnessAuthKind[]` this harness is compatible with, in the founder decision matrix's order. |
| `subscriptionAuth` | `'oauth-device' \| 'oauth-token' \| null` — the harness's subscription auth flow, if it has one. |

`harnessesByStability(stability)` (`packages/shared/src/harnesses.ts:112-115`)
returns the `HarnessId[]` matching a stability tier, in `HARNESS_IDS` order —
the one place "which harnesses are experimental" is computed, consumed by
both the api gate and the web/api capability derivations below.

### Who consumes it (the derivation map)

| Consumer | What it derives | Source |
|---|---|---|
| `manifest-schema` | `V3_HARNESS_VALUES`, the v3 `kortix.yaml` schema's `harness` enum | `packages/manifest-schema/src/constants.ts:28` — `export const V3_HARNESS_VALUES = [...HARNESS_IDS] as const;`; guarded by `packages/manifest-schema/src/__tests__/harness-source.test.ts` |
| `apps/api` — config dirs | `DEFAULT_CONFIG_DIR`, the per-harness default config directory used when compiling a runtime config | `apps/api/src/projects/lib/compile-runtime-config.ts:58` — `HARNESS_IDS.map((id) => [id, HARNESSES[id].configDir])` |
| `apps/api` — zod enums | `RuntimeProfileSchema.harness` request validation | `apps/api/src/projects/routes/agent-config.ts:98` — `harness: z.enum(HARNESS_IDS)` |
| `apps/api` — capabilities | `computeDefaultAllowed` (owns-default leg), `model.live_change`, connection compatibility | `apps/api/src/projects/lib/composer-capabilities.ts` (`HARNESSES[input.harness].ownsDefaultModel`, `.liveModelChange`); pinned by `apps/api/src/projects/lib/harness-capability-conformance.test.ts` |
| `apps/api` — gating | Which harnesses are selectable behind `experimental_harnesses` | `apps/api/src/projects/lib/composer-capabilities.ts:339` (`EXPERIMENTAL_HARNESSES = new Set(harnessesByStability('experimental'))`) and `apps/api/src/projects/lib/agent-config-v2.ts:129` (`EXPERIMENTAL_HARNESS_IDS`) |
| `apps/api` — config validation | Per-harness native config lint severity (`error` only for `stable` harnesses) | `apps/api/src/projects/lib/harness-config-validate.ts:31-33` — `severityFor()` reads `HARNESSES[harness].stability` |
| `apps/api` — runtime model | Whether a launch model needs its `kortix/` prefix stripped | `apps/api/src/projects/lib/session-runtime-env.ts:33-41` — `runtimeModelForHarness()` reads `HARNESSES[harness].modelNamespacing` |
| `apps/web` — labels/config-dirs | `ACP_HARNESS_LABELS`, `ACP_HARNESS_CONFIG_DIRS` (runtime profile editor) | `apps/web/src/features/workspace/customize/sections/view/runtime-profile-options.ts:8-13` |
| `apps/web` — order | `AGENT_GROUP_ORDER`, the agent picker's harness group heading order | `apps/web/src/features/session/agent-selector-helpers.ts:23` — `[...HARNESS_IDS, 'other']` |
| `apps/web` — compat | `METHOD_COMPATIBLE_HARNESSES`, which harnesses each auth connection kind supports | `apps/web/src/features/workspace/customize/sections/llm-provider/connect-model-modal.tsx:63-65` — filters `HARNESS_IDS` by `HARNESSES[id].authKinds.includes(kind)` |
| `@kortix/sdk` mirror | `SDK_HARNESS_IDS`, a hand-maintained copy (the SDK core takes no runtime dependency on `@kortix/shared`) | `packages/sdk/src/acp/harness-mirror.ts`; drift-guarded by `packages/sdk/src/acp/harness-mirror.drift.test.ts`, which imports `@kortix/shared` as a devDependency only |
| Sandbox agent server | `ACP_HARNESS_IDS` + per-harness launch commands, another hand-maintained copy (the sandbox ships as a dependency-free `bun build --compile` binary) | `apps/kortix-sandbox-agent-server/src/acp/harness-registry.ts`; conformance-guarded by `apps/kortix-sandbox-agent-server/src/acp/harness-registry.conformance.test.ts` |

The last two rows are not typos: the SDK and the sandbox agent server
**cannot** import `@kortix/shared` at runtime (the SDK core is
dependency-minimal and framework-free; the sandbox agent server ships as a
standalone binary with zero `@kortix/*` runtime dependencies), so both hand-
maintain their own copy of the harness id tuple and rely on a devDependency-
only test to catch drift. Everything else in the table above imports
`HARNESS_IDS`/`HARNESSES` directly and derives automatically.

## The harness matrix

Values below are copied verbatim from `packages/shared/src/harnesses.ts`
(`HARNESSES`, lines 61-110). If this table and the source ever disagree, the
source wins — re-copy it.

| id | label | adapter package | config dir | stability | model namespacing | owns default | live model change | auth kinds |
|---|---|---|---|---|---|---|---|---|
| `claude` | Claude Code | `@agentclientprotocol/claude-agent-acp` | `.claude` | experimental | bare | yes | no | `claude_subscription`, `anthropic_api_key`, `native_config` |
| `codex` | Codex | `@agentclientprotocol/codex-acp` | `.codex` | experimental | bare | yes | no | `codex_subscription`, `openai_api_key`, `native_config` |
| `opencode` | OpenCode | `opencode-ai` | `.kortix/opencode` | stable | gateway-prefixed | no | yes | `managed_gateway`, `anthropic_api_key`, `openai_api_key`, `openai_compatible`, `native_config` |
| `pi` | Pi | `pi-acp` | `.pi` | experimental | bare | yes | no | `managed_gateway`, `anthropic_api_key`, `openai_api_key`, `openai_compatible`, `native_config` |

`subscriptionAuth`: `claude` → `oauth-token`, `codex` → `oauth-device`,
`opencode`/`pi` → `null` (no subscription flow).

## Founder auth decisions (2026-07-15)

Pinned in `apps/api/src/projects/lib/composer-capabilities.ts`'s `CONNECTIONS`
table (`compatible_harnesses` per auth kind) and its top-of-block comment
(lines 74-82):

- **Claude Code and Codex are harness-access only.** Their `authKinds` are
  limited to their own subscription, their own provider API key, and
  `native_config` — **never** `managed_gateway`, **never**
  `openai_compatible`/`anthropic_compatible`. `HARNESSES.claude.authKinds` and
  `HARNESSES.codex.authKinds` both omit `managed_gateway` entirely (see the
  matrix above).
- **OpenCode and Pi keep the full gateway story** — `managed_gateway`,
  `anthropic_api_key`, `openai_api_key`, `openai_compatible`, and
  `native_config` are all compatible with both.
- **`anthropic_compatible` is parked.** The auth-kind still exists in the
  `HarnessAuthKind` union and in `CONNECTIONS` (`compatible_harnesses: []`,
  `apps/api/src/projects/lib/composer-capabilities.ts:122-126`) — it is not
  deleted, only unreachable from any harness's `authKinds` and therefore from
  any UI surface today.

These decisions are pinned by named tests, not just prose:

- `apps/api/src/projects/lib/composer-capabilities.test.ts:150` —
  `describe('founder decision 2026-07-15 pins (WS2-P4-a): claude/codex
  harness-only, opencode/pi keep the gateway, anthropic_compatible parked')`,
  asserting the exact `compatible_harnesses` sets above.
- `apps/kortix-sandbox-agent-server/src/acp/harness-registry.conformance.test.ts:78-352`
  — `describe('env-based auth: descriptor authKinds reach the right env names
  (WS2-P4-a)')` and its sibling `describe` blocks, which walk the real
  `isolateHarnessAuthEnv`/`resolveAcpHarnessLaunchEnv` env pipeline for every
  `authKinds` entry and assert credential isolation (e.g. an OpenAI key never
  reaches a Claude child process) and the one documented asymmetry: Codex
  subscription auth (`CODEX_AUTH_JSON`) never reaches the adapter directly —
  it always routes through the Kortix gateway with the sandbox token, unlike
  Claude's `claude_subscription`, which forwards `CLAUDE_CODE_OAUTH_TOKEN`
  straight through.

## Experimental gating

`HARNESSES[id].stability` drives the `experimental_harnesses` feature flag
(`apps/api/src/experimental/features.ts:130-145`):

- OpenCode (`stability: 'stable'`) is **never** gated — it is always
  selectable regardless of the flag.
- Claude, Codex, and Pi (`stability: 'experimental'`) are selectable only once
  a project opts into `experimental_harnesses` in Settings → Experimental.
  `platformDefault: () => false` — off unless a project explicitly enables it.

The gate applies to **selection/start only**, never to parsing or compiling a
manifest that already declares all four runtimes (the shipped base template
does this unconditionally) — see the comment at
`apps/api/src/projects/lib/agent-config-v2.ts:131-140`.

Gate sites:

- `apps/api/src/projects/lib/composer-capabilities.ts:339-347` —
  `EXPERIMENTAL_HARNESSES = new Set(harnessesByStability('experimental'))` and
  `isExperimentalHarnessGated()`, which blocks `can_start` and sets
  `blocking_reason` on the composer capabilities response for a gated harness.
- `apps/api/src/projects/lib/agent-config-v2.ts:126-149` —
  `EXPERIMENTAL_HARNESS_IDS` and `experimentalHarnessesInRuntimeProfiles()`,
  the pure predicate the write route below calls.
- `apps/api/src/projects/routes/agent-config.ts:244-254` — the
  `PUT /{projectId}/runtime-profiles` route: if any harness in the submitted
  runtime profiles is gated and the project hasn't enabled
  `experimental_harnesses`, the request 422s with
  `code: 'experimental_harness_disabled'`.

Both the capabilities-side and the write-route-side gates derive from
`harnessesByStability('experimental')` — zero hardcoded harness lists, so a
harness's gating follows its `stability` field automatically.

## How to add a harness

Adding a fifth harness touches a small, well-defined set of files. Follow
this order:

1. **Add the descriptor entry.** In `packages/shared/src/harnesses.ts`, add
   the new id to `HARNESS_IDS` and a full `HarnessDescriptor` entry to
   `HARNESSES` (every field above — there is no default). Pin the adapter's
   exact semver version in `packages/shared/src/runtime-versions.json` (add a
   new key) and export a matching constant from
   `packages/shared/src/runtime-versions.ts`. `runtime-versions.test.ts`
   already asserts every value in `RUNTIME_VERSIONS` is an exact `x.y.z` pin
   (`packages/shared/src/runtime-versions.test.ts:28-32`) — no edit needed
   there, it iterates `Object.values()`.

2. **Update the sandbox registry launch mechanics.** `harness-registry.ts`
   (`apps/kortix-sandbox-agent-server/src/acp/harness-registry.ts`) is the
   **one place imperative launch lives** — it is a hand-maintained mirror
   (the sandbox agent server ships with zero `@kortix/*` runtime
   dependencies), not derived from `@kortix/shared`. Add the new id to
   `ACP_HARNESS_IDS`, a `DEFAULTS` entry (display name, adapter, launch
   command/args), a `nativeConfigEnv()` branch (its own distinct
   `*_CONFIG_DIR`-style env var — see the comment at
   `harness-registry.conformance.test.ts:41-51` on why this must be distinct per harness), and
   a `resolveAcpHarnessLaunchEnv()` branch for its auth wiring. Its
   conformance test,
   `apps/kortix-sandbox-agent-server/src/acp/harness-registry.conformance.test.ts`,
   fails red on a missing id (`'covers exactly HARNESS_IDS'`) or a missing
   distinct native-config env var — treat that failure as the checklist for
   this step.

3. **Update the SDK mirror.** `packages/sdk/src/acp/harness-mirror.ts`'s
   `SDK_HARNESS_IDS` is the SDK's own hand-maintained copy (the SDK core
   cannot take a runtime dependency on `@kortix/shared` — see that file's doc
   comment). Add the new id there. Its drift test,
   `packages/sdk/src/acp/harness-mirror.drift.test.ts`, fails red until you
   do — that failure is the signal, not something to route around.

4. **Add the adapter install to `dockerfile-layer.ts`,
   pinned.** (`apps/api/src/snapshots/dockerfile-layer.ts`, the `npm install
   -g` step around line 264.) Use the exact semver constant from step 1 —
   never a floating tag. Add a `command -v <bin> && <bin> --version` (or
   `--help`) probe immediately after, in the same `&&`-chained, non-`set +e`
   `RUN` step (an install without a probe, or a probe that's best-effort,
   both violate the packaging law).
   `apps/api/src/snapshots/packaging-law.test.ts` pins this — but note its
   `for (const pin of [...])` list and its `probes` map (lines 98-104,
   135-141) are **hand-maintained hardcoded lists of the current adapter
   set (five pins covering the four harnesses), not derived from `HARNESS_IDS`**. Nothing fails automatically if
   you simply forget to add the harness's install line at all; what the test
   *does* catch, once you've added it, is a non-pinned version, an `@latest`
   tag, a missing probe, or a probe that runs after `ENTRYPOINT`
   (`packaging-law.test.ts:96-162`). Extend the test's hardcoded lists
   yourself for the new adapter to get equivalent coverage.

### What happens automatically (once steps 1-4 above are done)

These consumers import `HARNESS_IDS`/`HARNESSES` (or `harnessesByStability`)
directly and re-derive on their own — no code change needed:

- **Manifest enum** — `V3_HARNESS_VALUES` (`packages/manifest-schema/src/constants.ts:28`)
  and the generated JSON Schema `harness` enum
  (`packages/manifest-schema/src/json-schema.ts:510`).
- **API enums** — `RuntimeProfileSchema.harness`
  (`apps/api/src/projects/routes/agent-config.ts:98`).
- **API config-dirs** — `DEFAULT_CONFIG_DIR`
  (`apps/api/src/projects/lib/compile-runtime-config.ts:58`).
- **API capabilities/gating** — `computeDefaultAllowed`, `live_change`,
  `runtimeModelForHarness`, `isExperimentalHarnessGated`,
  `experimentalHarnessesInRuntimeProfiles` (all listed in the derivation map
  above) — a new harness's `ownsDefaultModel`/`liveModelChange`/
  `modelNamespacing`/`stability` flow straight through.
- **Web labels/compat/order** — `ACP_HARNESS_LABELS`, `ACP_HARNESS_CONFIG_DIRS`,
  `AGENT_GROUP_ORDER`, `METHOD_COMPATIBLE_HARNESSES` (all listed in the
  derivation map above).

### What needs manual thought (no descriptor field decides it for you)

- **Auth kinds.** `authKinds` (step 1) is a judgment call, not a derivation —
  decide which `HarnessAuthKind`s the harness genuinely supports, then also
  add matching entries to `CONNECTIONS.<kind>.compatible_harnesses` in
  `apps/api/src/projects/lib/composer-capabilities.ts` (that table is
  hand-maintained per auth kind, keyed the other direction from the
  descriptor — see the Founder auth decisions section above for the current
  matrix and its rationale).
- **Warm-up posture.** Only OpenCode gets a build-time DB-migration bake and
  project-instance warm-up in `dockerfile-layer.ts`
  (`apps/api/src/snapshots/packaging-law.test.ts:214-243` pins that Claude,
  Codex, and Pi are installed and probed but never warmed). A new harness
  defaults to cold-start unless you deliberately add a warm-up step.
- **Model namespacing choice.** `modelNamespacing: 'gateway-prefixed' | 'bare'`
  decides whether a `kortix/`-prefixed gateway model id is stripped before
  reaching the harness (`session-runtime-env.ts`'s `runtimeModelForHarness`).
  Get this wrong and the harness receives a model id it doesn't recognize.
- **Template seed.** The starter template
  (`packages/starter/templates/base/`) ships one native config directory per
  existing harness (`.claude`, `.codex`, `.kortix/opencode`, `.pi`) with seed
  agent files. Nothing derives this from the descriptor — add the new
  harness's config directory and seed content by hand if you want it to have
  out-of-the-box agent files.
