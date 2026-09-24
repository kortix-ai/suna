# @kortix/llm-catalog

This package supplies the bundled provider catalog and the Kortix managed model lineup. The API owns runtime routing and the live served catalog.

## Managed models

The picker groups every managed model under **Kortix**, and the provider is always Kortix. Requests use Kortix credits. Project BYOK providers remain separate.

| Picker name | Gateway model ID | Morph model ID | Input | USD per 1M input / cached input / output tokens |
| --- | --- | --- | --- | --- |
| DeepSeek V4.1 Flash (default) | `deepseek-v4.1-flash` | `morph-dsv41flash` | Text, image | $0.15 / $0.0359375 / $0.60 |
| GLM-5.3-Flash | `glm-5.3-flash` | `morph-glm53flash` | Text, image | $0.10 / $0.02 / $0.35 |
| Kimi K3 2.8T | `kimi-k3` | `morph-kimik3` | Text, image | $2.50 / $0.29 / $14.00 |

The prices are Morph's list prices on 2026-09-24 (`https://docs.morphllm.com/llms.txt`). Morph publishes no cached rate for DeepSeek V4.1 Flash; the table uses its DeepSeek V4 Flash cached rate. All rates exclude Kortix credit markup.

The OpenCode reference is `kortix/<gateway model ID>`. The bundled sandbox fallback (`MINIMAL_FALLBACK_MODELS`) uses the same IDs, prices, and capabilities.

### Routing: Morph first, OpenRouter pool second

1. The gateway sends the request to Morph's OpenAI-compatible API (`MORPH_API_URL`, `MORPH_API_KEY`) with the Morph model ID.
2. When Morph fails before any output (non-2xx status or network error), the gateway sends the same request to OpenRouter (`OPENROUTER_API_KEY`) with the OpenRouter model ID. The descriptor field `failover: true` enables this; `packages/llm-gateway/src/pipeline/simple-handler.ts` implements it. BYOK descriptors never set it.
3. OpenRouter routes inside the model's endpoint pool: `only` lists the pool, `allow_fallbacks: true` lets OpenRouter move to the next pool member on an endpoint error, `zdr: true` and `data_collection: deny` are forced by the gateway, and `max_price` (USD per 1M tokens) excludes premium tiers.

A failure after output has started is not retried. The client receives the stream error.

Billing: a Morph request bills the table above. An OpenRouter request bills OpenRouter's reported `usage.cost` for the endpoint that served it, so a fallback costs at most `max_price`.

A deployment with only one of the two keys serves managed models through that provider alone.

### OpenRouter fallback pools

Every pool member has a **confirmed US datacenter**. OpenRouter lists the provider's headquarters AND datacenters as US (`/api/v1/providers`), or the endpoint tag names the US region (`/us`). US headquarters alone does not qualify. Every member is also in OpenRouter's ZDR endpoint feed (`/api/v1/endpoints/zdr`), checked on 2026-09-24.

| Model | Pool (`only`) | `max_price` prompt / completion |
| --- | --- | --- |
| DeepSeek V4.1 Flash | `morph`, `coreweave/fp8` | $0.30 / $1.20 |
| GLM-5.3-Flash | `morph`, `decart/fp4`, `coreweave/nvfp4`, `sail-research/us` | $0.15 / $0.50 |
| Kimi K3 2.8T | `morph`, `fireworks/us` | $3.30 / $16.50 |

Probe results on 2026-09-24, as pools with `allow_fallbacks: true`:
- 30 of 30 text and image requests returned HTTP 200.
- OpenRouter routes by price, so `morph` serves most requests.

Known limits:
- `sail-research/us` serves GLM text only. OpenRouter skips it for image requests.
- `coreweave/fp8` twice answered a DeepSeek image request as if no image was sent. It stays because it is the only other US-datacenter DeepSeek endpoint. A request reaches it only after Morph direct and Morph through OpenRouter both fail.
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
