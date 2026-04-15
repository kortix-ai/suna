# OpenCode Config Fail-Soft Spec

## Problem

Today, one invalid user config file can effectively brick OpenCode for an instance.

Observed failure:

```json
{
  "status": 500,
  "data": {
    "name": "ConfigInvalidError",
    "data": {
      "path": "/workspace/.opencode/opencode.jsonc",
      "issues": [
        {
          "code": "unrecognized_keys",
          "keys": ["models"],
          "path": [],
          "message": "Unrecognized key: \"models\""
        }
      ]
    }
  }
}
```

Real affected file on the sandbox:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "models": [
    {
      "name": "qwen-local",
      "endpoint": "https://engine.steelelogan.com/v1",
      "api_key": " Dud",
      "model": "Qwen3.5-35B-A3B-UD-Q4_K_XL.gguf"
    }
  ]
}
```

This is a legacy/foreign config shape. OpenCode treats it as fatal, and then:

- `/session/status` returns 500
- `/session` returns 500
- `/provider`, `/config`, `/agent`, etc. all return 500
- Kortix sees runtime layer degraded even though host and workload are healthy

That is unacceptable. Invalid config must degrade the runtime, not take it down.

---

## Research findings

### 1. OpenCode currently fails hard on invalid config

Relevant code:

- `research/opencode/packages/opencode/src/config/config.ts`
- `research/opencode/packages/opencode/src/config/paths.ts`
- `research/opencode/packages/opencode/src/server/middleware.ts`

Key behavior:

1. `ConfigPaths.InvalidError` is thrown for schema-invalid config
2. `loadInstanceState()` merges config from many sources
3. any invalid file throws and aborts the whole config load
4. server error middleware returns that as HTTP 500

So one bad config source poisons the whole instance.

### 2. OpenCode already has partial migration behavior

OpenCode already strips some legacy keys safely:

- `theme`
- `keybinds`
- `tui`

So there is precedent for **compatibility migrations** in config loading.

### 3. Kortix should not rely only on startup wrappers

Even though Kortix launches OpenCode via:

- `suna/core/kortix-master/scripts/run-opencode-serve.sh`

the true issue is inside OpenCode config loading itself. A wrapper can help, but it is not sufficient because:

- there are multiple config sources
- runtime reloads can re-trigger config parsing later
- the proper fix belongs in the OpenCode config layer

---

## Goals

### G1. Invalid config must not take down OpenCode

OpenCode must continue serving requests using the last-known-good or default config.

### G2. Invalid config must be reported clearly

We need a structured way to know:

- config is degraded
- which file is invalid
- which issues were found

### G3. Known legacy shapes should auto-migrate when safe

For example, the legacy top-level `models` array should be either:

- converted automatically, or
- ignored with a clear warning and optional backup

### G4. Kortix should surface config degradation without pretending the runtime is healthy

The layer-3 health should become:

- `degraded`
- with explicit `config_error`

not a vague generic 500 state.

---

## Recommended solution

## Layer A — Fix OpenCode itself (primary fix)

Patch OpenCode config loading so invalid files become **non-fatal diagnostics**.

### A1. Add config diagnostics state

In `research/opencode/packages/opencode/src/config/config.ts`:

- extend config state to carry diagnostics, e.g.

```ts
type ConfigProblem = {
  path: string
  name: string
  message?: string
  issues?: unknown[]
  scope: "global" | "local" | "managed" | "env"
}
```

- store them in the config service state
- expose a getter such as:

```ts
readonly problems: () => Effect.Effect<ConfigProblem[]>
```

### A2. Fail soft per file/source

Wrap every config-source load in a safe loader.

Current pattern:

- `loadFile()` / `loadConfig()` throws
- `loadInstanceState()` aborts

Replace with:

```ts
const safeLoad = Effect.fnUntraced(function* (source, effect) {
  const exit = yield* effect.pipe(Effect.exit)
  if (Exit.isSuccess(exit)) return exit.value
  const err = Cause.squash(exit.cause)
  if (err instanceof JsonError || err instanceof InvalidError) {
    problems.push(...)
    log.warn("invalid config ignored", { source, error: String(err) })
    return {}
  }
  return yield* Effect.failCause(exit.cause)
})
```

Use this for:

- global config files
- project `.opencode/opencode.jsonc`
- managed config files
- remote account config
- `OPENCODE_CONFIG_CONTENT`

Important: invalid config becomes **ignored + recorded**, not fatal.

### A3. Keep normal fatal behavior for truly non-config crashes

Do **not** swallow:

- transport bugs
- code bugs
- internal exceptions unrelated to config parsing

Only soften:

- `ConfigJsonError`
- `ConfigInvalidError`

---

## Layer B — Add compatibility migration for known legacy `models`

We already know a concrete bad shape exists:

```jsonc
{
  "models": [
    {
      "name": "qwen-local",
      "endpoint": "https://engine.steelelogan.com/v1",
      "api_key": " Dud",
      "model": "Qwen3.5-35B-A3B-UD-Q4_K_XL.gguf"
    }
  ]
}
```

This should be migrated before schema validation.

### B1. Add a legacy normalizer in OpenCode config loading

Before `Info.safeParse(normalized)`, transform recognized legacy shapes.

Suggested function:

```ts
function normalizeLegacy(data: unknown, source: string) {
  // already handles tui/theme/keybinds
  // add legacy top-level models array support
}
```

### B2. Transform legacy models array to `provider` config

Suggested output shape for each legacy model entry:

```jsonc
{
  "provider": {
    "qwen-local": {
      "name": "qwen-local",
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "https://engine.steelelogan.com/v1",
        "apiKey": " Dud"
      },
      "models": {
        "default": {
          "name": "qwen-local",
          "id": "Qwen3.5-35B-A3B-UD-Q4_K_XL.gguf",
          "family": "qwen-local"
        }
      }
    }
  }
}
```

Notes:

- if there are multiple legacy entries, generate multiple providers
- preserve original values as faithfully as possible
- log a warning that automatic migration was applied

### B3. Write a backup only if we auto-rewrite

Preferred behavior:

- runtime uses normalized in-memory config immediately
- optional follow-up command can rewrite the user file later

We should **not** silently mutate user config on every boot unless clearly intentional.

---

## Layer C — Surface config degradation explicitly

Even if runtime continues serving, we need to know config is degraded.

### C1. Add a config-status endpoint in OpenCode

Add something like:

- `GET /config/status`

Response:

```json
{
  "valid": false,
  "problems": [
    {
      "path": "/workspace/.opencode/opencode.jsonc",
      "name": "ConfigInvalidError",
      "issues": [...]
    }
  ]
}
```

### C2. Or include problems in `/config`

If we want less API surface, `/config` can return:

```json
{
  ...config,
  "_status": {
    "valid": false,
    "problems": [...]
  }
}
```

Either approach is fine. Dedicated `/config/status` is cleaner.

### C3. Kortix health integration

Then in Kortix Master:

- `/kortix/health` can include:

```json
{
  "status": "ok",
  "runtimeReady": true,
  "configValid": false,
  "configProblems": [...]
}
```

This lets the runtime stay up while still signaling degradation.

---

## Layer D — Kortix-side guardrail (secondary fix)

Even after patching OpenCode, add a small Kortix-side safeguard.

### D1. Preflight validator in `run-opencode-serve.sh`

Before launching OpenCode:

- detect known-bad config file(s)
- optionally run a lightweight migration/sanity check
- write a marker file under `/ephemeral/kortix-master/opencode-config-status.json`

Purpose:

- fast visibility at boot
- fallback telemetry if OpenCode itself is still unhealthy

### D2. Do not rely on this as the primary fix

This is defense-in-depth only.

The primary fix remains inside OpenCode config loading.

---

## Behavior after the fix

### Case 1 — invalid config with known migration

- OpenCode starts
- config loads after in-memory migration
- `/session/status` returns 200
- `/config/status` says `valid: false` or `migrated: true`

### Case 2 — invalid config with unknown schema violation

- OpenCode starts with defaults / remaining valid config
- offending file is skipped
- `/session/status` returns 200
- `/config/status` returns the problem details

### Case 3 — malformed JSONC

- OpenCode starts with valid remaining config/defaults
- bad file is skipped
- `/config/status` reports parse error with path and line info if available

---

## What should NOT happen anymore

- one bad `.opencode/opencode.jsonc` causes `/session/status` 500 forever
- one invalid field takes down `/provider`, `/config`, `/agent`, `/command`, etc.
- runtime health becomes unusable because config parsing is strict-fatal

---

## Recommended implementation order

### Phase 1 — fail-soft foundation

1. patch OpenCode config loader to catch per-source config errors
2. store config problems in state
3. add tests proving invalid config no longer breaks `/session/status`

### Phase 2 — legacy `models` migration

4. add normalizer for top-level `models` array
5. test with the exact bad config seen in production/dev

### Phase 3 — surfacing

6. add `/config/status` (or config status payload)
7. propagate into Kortix `/kortix/health` and runtime-layer health

### Phase 4 — optional UX

8. show banner/warning in UI when config is degraded
9. optionally add a “repair config” or “view config errors” action

---

## Acceptance criteria

### Required

- invalid `/workspace/.opencode/opencode.jsonc` no longer causes `/session/status` 500
- runtime remains usable with defaults or remaining valid config
- config problem is machine-readable via endpoint/status

### Strongly preferred

- legacy top-level `models` config automatically migrates
- Kortix health reflects `runtime healthy but config degraded`

---

## Recommendation

Do **both**:

1. **Patch OpenCode** so config errors are non-fatal and tracked
2. **Add Kortix health/config reporting** so degraded config is visible

That is the real “once and for all” fix.

Anything wrapper-only will be partial and brittle.
