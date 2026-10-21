# @kortix/llm-catalog

This package supplies the bundled provider catalog and the Kortix managed model lineup. The API owns runtime routing and the live served catalog.

## Managed models

Kimi K3 (`kimi-k3`) left the lineup on 2026-10-19. A session or default that names it runs on DeepSeek V4.1 Flash (`LEGACY_MANAGED_IDS`).

The picker groups every managed model under **Kortix**, and the provider is always Kortix. Requests use Kortix credits. Project BYOK providers remain separate.

| Picker name | Gateway model ID | Input | USD per 1M input / cached input / output tokens |
| --- | --- | --- | --- |
| DeepSeek V4.1 Flash (default) | `deepseek-v4.1-flash` | Text, image | $0.15 / $0.003 / $0.60 |
| GLM-5.3-Flash | `glm-5.3-flash` | Text, image | $0.10 / $0.02 / $0.35 |

The prices are Kortix Platinum inference's price list. All rates exclude the Kortix platform fee (`KORTIX_LLM_MARKUP`, default `1.055`). The OpenCode reference is `kortix/<gateway model ID>`. The bundled sandbox fallback (`MINIMAL_FALLBACK_MODELS` in `@kortix/api-contract`) uses the same IDs, prices, and capabilities.

### Serving: Kortix Platinum inference

Every managed model has one upstream: Kortix Platinum inference (`managedCandidates` in `apps/api/src/llm-gateway/resolution/descriptors.ts`). The API calls `PLATINUM_INFERENCE_URL` (default `https://api.platinum.dev/v1/inference`) with `PLATINUM_INFERENCE_API_KEY`, a `pt_live_` key with the `inference:write` scope. Without the key no managed model is served or offered.

1. Platinum owns the model's upstreams, their order, failover between them, and their zero-data-retention terms. This repository has no upstream-specific code.
2. The gateway sends `x-platinum-session` (the Kortix session, else the API key, else the user). Platinum keys upstream prompt caches by it.
3. Platinum reports its charge as `usage.cost` (USD). The gateway bills that cost × `KORTIX_LLM_MARKUP`. The model's `pricing` applies only to a response without `usage.cost`.
4. `usage_events.metadata.upstreamProvider` is `platinum`. The client sees only Kortix.
5. After Platinum fails, the platform fallback policy moves the request to the other managed model: `deepseek-v4.1-flash` falls back to `glm-5.3-flash` and back (`LLM_GATEWAY_FALLBACK_POLICIES`, `policy-config.ts`). `codex/gpt-5.6-sol` falls back to both, in that order.
6. A Free account may use only the platform default, and the platform policy's fallback model as that fallback only (`isPlatformDefaultFallback` in `resolve-candidates.ts`).

A failure after output has started is not retried. The client receives the stream error.

### Context windows

Every managed model publishes `limit: { context: 1_000_000, output: 65_536 }`. OpenCode compacts a session after a step that used `context - min(output, 32_000)` tokens. An upstream that checks prompt + `max_tokens` rejects a prompt above its window minus `max_tokens`. `src/managed.test.ts` holds the smallest window a serving upstream accepted and fails when a managed model's `limit` leaves less than 32,768 tokens of headroom, or when a managed model has no measured window. A change of Platinum upstream needs a new probe.

The gateway answers every overflow as HTTP 400 `context_length_exceeded`, including an error as the first `data:` frame of a stream (`packages/llm-gateway/src/http/call-upstream.ts`). OpenCode reads that code as a context overflow and compacts.

### OpenAI and Anthropic models are not managed

The managed lineup offers open-weight models only. OpenAI and Anthropic models reach members through BYOK (`openai/<id>`, `anthropic/<id>`) or a ChatGPT plan (`codex/<id>`). They never bill Kortix credits. `src/managed.test.ts` fails when a managed entry is an `openai/` or `anthropic/` model. Claude Opus 5.5, GPT-6 Sol, and GPT-6 Luna were added as managed on 2026-09-24 (#7561) and removed the same day.

`CATALOG` carries the models.dev records for `openai/gpt-6-sol`, `openai/gpt-6-luna`, `anthropic/claude-opus-5-5`, and their three OpenRouter ids. The BYOK and ChatGPT routes take reasoning effort, modalities, and `temperature` from them. The ChatGPT lineup (`apps/api/src/llm-gateway/models/codex-models.ts`) offers `codex/gpt-6-sol` and `codex/gpt-6-luna`.

GLM-5.3 744B (text input only), DeepSeek V4 Flash 0731, DeepSeek V4 Pro 0813, GLM-5.3-FlashX, and Qwen3.8 Max 0902 remain excluded.

## Catalog

`CATALOG` is the bundled models.dev snapshot. It lives in `src/catalog-data.ts`, not in `index.ts`, so a bundler drops the ~7.6 MB JSON for consumers that never read `CATALOG` or `catalogModelForWireModel`. `MANAGED_MODELS` contains the managed lineup. `PLATFORM_DEFAULT_MODEL_ID` is `deepseek-v4.1-flash`. The runtime catalog refreshes from the configured models.dev URL.

## License

Elastic-2.0.
