# LLM Gateway — unified, catalog-driven, type-checked provider mapping

**Status:** proposed (scoping) · **Date:** 2026-07-19 · **Owner:** platform/llm-gateway

## Problem

The AI-SDK gateway maps one incoming OpenAI-shaped request onto N provider
backends via **hand-written, per-provider branches** scattered through
`buildAiSdkArgs` (`packages/llm-gateway/src/transports/ai-sdk/request.ts`):

- `reasoning_effort` → `providerOptions.anthropic.thinking{adaptive}+effort`
  (anthropic) vs `providerOptions.bedrock.reasoningConfig{enabled,budgetTokens}`
  (bedrock) vs `providerOptions.openai.reasoningEffort` (openai) vs the
  `providerOptionsName` key for openai-compatible.
- `temperature`/`top_p` dropped for some families when thinking is on.
- `response_format`, penalties, seed, prompt-caching, maxTokens defaults — each
  with its own `if family === …` special-case.

Two structural problems fall out of this:

1. **Drift.** The mapping is maintained by hand against SDK internals. When
   Anthropic deprecated `thinking.type:"enabled"` in favor of
   `type:"adaptive"` + `output_config.effort`, our hardcoded `enabled` shape
   silently 400'd **every non-AUTO Anthropic turn** (the 2026-07-19 incident;
   fixed surgically in the anthropic-adaptive-thinking PR). Nothing type-checked
   the shape against the package, and nothing tied "which shape is legal" to the
   model.
2. **No single source of truth for capabilities.** Whether a model supports
   reasoning, which effort tiers, vision/attachment, temperature, structured
   output — all of that already lives in the **models.dev catalog**
   (`packages/llm-catalog`: `reasoning_options`, `modalities`, `temperature`,
   `tool_call`, `structured_output`, `attachment`, `cost`). But the request
   builder re-derives it ad hoc instead of reading the catalog.

## Goal

One canonical request shape flowing top-to-bottom, with the **models.dev catalog
as the single source of capability truth** and each provider's output
**type-checked against that SDK package's own exported option type**. Minimal,
uniform, correct-by-construction — no scattered per-call branches, no drift.

Non-goal: pretending the providers are identical. They are genuinely different
SDK packages with different wire contracts. The win is **one canonical input +
one thin, typed, data-driven adapter per provider**, not "zero transformation."

## Design

### 1. Canonical request (`GatewayRequest`)
Normalize the incoming OpenAI/Responses/opencode body **once** into a neutral,
fully-typed shape: messages, tools, tool_choice, `reasoningEffort?: EffortTier`,
`responseFormat?`, sampling (temperature/top_p/penalties/seed), maxTokens,
caching intent. This already half-exists (`toModelMessages`, `reasoningEffort`
helper); consolidate it into one typed struct so nothing downstream re-parses
the raw body.

### 2. Capability from the catalog (`ModelCapability`)
Resolve the target model against the models.dev catalog into a typed capability
record: `{ reasoning: EffortTier[] | false, temperature: bool, tool_call: bool,
attachment: bool, structured_output: bool, modalities, … }`. The catalog is the
**only** place that answers "what can this model do." (Today the daemon and the
picker already read these fields — reuse the same source.)

### 3. Per-provider typed adapters (`ProviderAdapter`)
A registry keyed by AI-SDK family. Each adapter is a pure function:

```ts
type ProviderAdapter<TOptions> = (
  req: GatewayRequest,
  cap: ModelCapability,
) => { providerOptions: { [providerKey]: TOptions }; callSettings: AiSdkCallSettings };
```

- `TOptions` is the **package's own exported type** — `AnthropicProviderOptions`
  (@ai-sdk/anthropic), `BedrockProviderOptions` (@ai-sdk/amazon-bedrock),
  `OpenAIResponsesProviderOptions`/`OpenAIChatProviderOptions` (@ai-sdk/openai),
  and the openai-compatible `providerOptionsName`-keyed shape. All confirmed
  exported. This makes every field name/enum **compiler-verified** — the exact
  check that would have caught `enabled`→`adaptive`.
- The adapter consults `cap` to decide *whether* and *how*: e.g. emit
  `thinking:{type:'adaptive'}+effort` only when `cap.reasoning` includes the
  requested tier; drop `temperature` when `cap.temperature === false`; pick the
  reasoning encoding the model actually supports.

### 4. One assembly point
`buildAiSdkArgs` becomes: `normalize → resolveCapability → adapters[family](req,
cap)`. No `if family` inside the mapping logic; family-specific knowledge lives
only inside that family's typed adapter.

## What this fixes / prevents
- The thinking drift class: shapes are checked against the SDK type, and
  "adaptive vs enabled" becomes a capability decision, not a constant.
- Silent param leakage (temperature to reasoning-only models, thinking to
  non-reasoning models) — gated by `cap`.
- New provider onboarding = add one typed adapter, not thread `if family`
  through a dozen sites.

## Rollout (incremental, parity-first — the gateway just stabilized in v0.10.12)
1. Land canonical `GatewayRequest` + `ModelCapability` (pure, tested) with **no
   behavior change** — adapters still produce byte-identical output to today.
2. Migrate one family at a time behind golden parity tests (snapshot the current
   `buildAiSdkArgs` output per family/case, prove the adapter reproduces it,
   then let capability-gating correct only the known-wrong cases like thinking).
3. Delete the old branches once all families are on adapters.
4. Guard test: a per-family test that the adapter's output type-checks against
   the SDK's exported option type (so an SDK bump surfaces a compile error, not
   a prod 400).

## Risks
- The catalog must be complete/accurate for capability gating; fall back to
  permissive (current behavior) when a model is absent, log it.
- Provider SDK version bumps can change option types → caught at compile time by
  design (that's the point), but requires the typed-adapter discipline.
- Do NOT big-bang: parity tests per family, ship incrementally.

## References
- Incident + surgical fix: `anthropic-adaptive-thinking` PR (adaptive+effort).
- Current mapping: `packages/llm-gateway/src/transports/ai-sdk/request.ts`.
- Catalog: `packages/llm-catalog` (models.dev fields).
- Exported option types: `AnthropicProviderOptions`, `BedrockProviderOptions`
  (verified exported in the installed packages).
