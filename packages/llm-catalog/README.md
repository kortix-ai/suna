# @kortix/llm-catalog

This package supplies the bundled provider catalog and the Kortix managed model lineup. The API owns runtime routing and the live served catalog.

## Managed models

The picker groups every managed model under **Kortix**, and the provider is always Kortix. Requests use Kortix credits. Project BYOK providers remain separate.

| Picker name | Gateway model ID | OpenRouter model ID | Input | Displayed USD per 1M input / cached input / output tokens |
| --- | --- | --- | --- | --- |
| DeepSeek V4.1 Flash (default) | `deepseek-v4.1-flash` | `deepseek/deepseek-v4.1-flash` | Text, image | $0.20 / $0.03 / $0.65 |
| GLM-5.3-Flash | `glm-5.3-flash` | `z-ai/glm-5.3-flash` | Text, image | $0.15 / $0.05 / $0.50 |
| Kimi K3 2.8T | `kimi-k3` | `moonshotai/kimi-k3` | Text, image | $3.30 / $0.33 / $16.50 |

The displayed prices are the OpenRouter pool prices, or the pool cap for GLM. OpenRouter requests bill its reported `usage.cost`. Direct Morph requests use the separate Morph prices in `MANAGED_MODELS`. All rates exclude Kortix credit markup.

The OpenCode reference is `kortix/<gateway model ID>`. The bundled sandbox fallback (`MINIMAL_FALLBACK_MODELS`) uses the same IDs, prices, and capabilities.

### Routing: per-model Morph selection

1. `MORPH_MANAGED_MODELS` is a comma-separated list of managed model IDs. Its default is `deepseek-v4.1-flash,kimi-k3`. GLM uses OpenRouter only. An empty value disables Morph for every managed model. Add `glm-5.3-flash` to explicitly enable Morph for GLM. The change takes effect after an API restart or deployment. A selected model uses Morph direct first when `MORPH_API_KEY` exists, then OpenRouter on a retryable error.
2. OpenRouter routes inside the model's endpoint pool: `only` lists the pool, `allow_fallbacks: true` lets OpenRouter move to the next pool member on an endpoint error, `zdr: true` and `data_collection: deny` are forced by the gateway, and `max_price` (USD per 1M tokens) excludes premium tiers. The gateway intersects operator-defined pools with the verified US endpoint list. Morph is excluded from every OpenRouter pool.
3. The OpenRouter model ID names the model author, not the inference host. The allowlist names the permitted hosts.

A failure after output has started is not retried. The client receives the stream error.

Billing uses OpenRouter's reported `usage.cost` for the endpoint that served the request, within the configured `max_price`. A direct Morph request uses its separate Morph list prices.

The project model picker lists each eligible managed route's estimated customer price for input, cached input, and output tokens. The API applies `KORTIX_LLM_MARKUP` (default `1.2`) to the public per-route rates before returning them. OpenRouter may select any allowed endpoint; its reported `usage.cost` determines the settled charge. The fallback tables were checked against [OpenRouter's model endpoint pages](https://openrouter.ai/docs/api/api-reference/endpoints/list-all-endpoints-for-a-model) and [Morph's current pricing](https://www.morphllm.com/pricing) on 2026-09-26. Refresh them when public rates change.

For a quick route change, set `MORPH_MANAGED_MODELS` in the deployment environment and restart the API. For example, `MORPH_MANAGED_MODELS=deepseek-v4.1-flash,kimi-k3,glm-5.3-flash` enables all three. Set `MORPH_MANAGED_MODELS=` to disable Morph globally. Direct Morph does not inherit OpenRouter's ZDR and US location controls; verify its contract before selecting models with restricted data.

Without `OPENROUTER_API_KEY`, GLM is unavailable by default. Other selected models require `MORPH_API_KEY` or `OPENROUTER_API_KEY`.

### OpenRouter endpoint pools

Every pool member has a **confirmed US datacenter**. OpenRouter lists the provider's headquarters AND datacenters as US (`/api/v1/providers`), or the endpoint tag names the US region (`/us`). US headquarters alone does not qualify. Every member was also in OpenRouter's ZDR endpoint feed (`/api/v1/endpoints/zdr`), rechecked on 2026-09-26. The `zdr: true` request flag fails closed when an endpoint loses ZDR status. The global OpenRouter API URL does not itself guarantee that OpenRouter's gateway processing stays in the US.

| Model | Pool (`only`) | `max_price` prompt / completion |
| --- | --- | --- |
| DeepSeek V4.1 Flash | `coreweave/fp8` | $0.30 / $1.20 |
| GLM-5.3-Flash | `decart/fp4`, `coreweave/nvfp4` | $0.15 / $0.50 |
| Kimi K3 2.8T | `fireworks/us` | $3.30 / $16.50 |

The 2026-09-24 probe included Morph. The reduced OpenRouter pools were probed with text and image inputs on 2026-09-26.

Known limits:
- `sail-research/us` serves GLM text only. OpenRouter skips it for image requests.
- `coreweave/fp8` twice answered a DeepSeek image request as if no image was sent. It is now the only permitted DeepSeek endpoint, so image behavior needs a fresh probe before release.
- `coreweave/nvfp4` returns HTTP 429 from a shared pool most of the time; see below.
- `decart/fp4` is fp4 quantization.

Excluded on 2026-09-24:
- **US headquarters without a confirmed US datacenter:** `wafer`, `together`, `parasail/*`, `io-net/fp8`, `novita/fp8`, `phala*`, `baseten/fp8`, `fireworks`, `deepinfra/*`, `modal*`, `inference-net/fp4`, `open-inference/fp4`, `crusoe/fp4`, `krea/fp8`, `sail-research/fp4`.
- **Non-US or unknown location:** `z-ai/fp8` (SG), `siliconflow/fp8` (US datacenters, SG headquarters), `inceptron/fp8` (FI), `nextbit/fp8` (ES), `moonshotai/mxfp4` (SG), `dekallm` (ID), `relace`, `near-ai/fp8`, `digitalocean`, `reka`, `makora`.
- **Image input rejected (HTTP 400):** `venice` (GLM) and `venice/fp8` (DeepSeek).
- **Above `max_price`:** `morph/fast` for Kimi ($6.00 / $22.50).

### Why GLM-5.3-Flash failed before 2026-09-24

The route pinned one endpoint (`only: ['coreweave/nvfp4']`, `allow_fallbacks: false`). CoreWeave serves OpenRouter's non-BYOK traffic from a shared pool. On 2026-09-24 that pool returned HTTP 429 `rate_limit_exceeded` (`limit_source: upstream_provider_shared_pool`) for 11 of 15 requests that OpenRouter routed to it. With a single pin and no fallback, every such 429 reached the user. The same 429 was recorded on 2026-09-18.

### OpenAI and Anthropic models are not managed

The managed lineup offers open-weight models only. OpenAI and Anthropic models reach members through BYOK (`openai/<id>`, `anthropic/<id>`) or a ChatGPT plan (`codex/<id>`). They never bill Kortix credits. `src/managed.test.ts` fails when a managed entry routes to an `openai/` or `anthropic/` upstream. Claude Opus 5.5, GPT-6 Sol, and GPT-6 Luna were added as managed on 2026-09-24 (#7561) and removed the same day.

`CATALOG` carries the models.dev records for `openai/gpt-6-sol`, `openai/gpt-6-luna`, `anthropic/claude-opus-5-5`, and their three OpenRouter ids. The BYOK and ChatGPT routes take reasoning effort, modalities, and `temperature` from them. The ChatGPT lineup (`apps/api/src/llm-gateway/models/codex-models.ts`) offers `codex/gpt-6-sol` and `codex/gpt-6-luna`.

GLM-5.3 744B accepts only text input and is excluded.

DeepSeek V4 Flash 0731 and DeepSeek V4 Pro 0813 remain excluded. DeepSeek reports that V4.1 Flash supersedes V4 Pro for performance, cost, speed, and task completion.

GLM-5.3-FlashX remains excluded. On 2026-09-21, OpenRouter listed one `z-ai/fp8` endpoint. The endpoint was ZDR and multimodal, but its provider region was Singapore. Pinned text and image requests also returned HTTP 429. This route does not meet the US inference residency requirement.

Qwen3.8 Max 0902 remains excluded. On 2026-09-21, OpenRouter listed one `alibaba` endpoint at $2.00 / $0.25 / $6.00 per million input / cached input / output tokens. The endpoint supports text, image, and video with a 1,000,000-token context window. It was absent from the account's ZDR endpoint feed, and pinned text and image requests returned HTTP 404 because no endpoint matched the ZDR policy. OpenRouter reported Alibaba datacenters only in Singapore and China. This route meets neither the ZDR nor US inference residency requirement.

## Catalog

`CATALOG` is the bundled models.dev snapshot. It lives in `src/catalog-data.ts`, not in `index.ts`, so a bundler drops the ~7.6 MB JSON for consumers that never read `CATALOG` or `catalogModelForWireModel`. `MANAGED_MODELS` contains the managed lineup. `PLATFORM_DEFAULT_MODEL_ID` is `deepseek-v4.1-flash`. The runtime catalog refreshes from the configured models.dev URL.

## License

Elastic-2.0.
