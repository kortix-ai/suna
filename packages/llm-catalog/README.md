# @kortix/llm-catalog

This package supplies the bundled provider catalog and the Kortix managed model lineup. The API owns runtime routing and the live served catalog.

## Managed models

The managed lineup uses OpenRouter routes pinned to named zero-data-retention endpoints. The model picker groups every managed model under **Kortix**. Requests use Kortix credits. Project BYOK providers remain separate.

| Picker name | Gateway model ID | Input | USD per 1M input / cached input / output tokens |
| --- | --- | --- | --- |
| DeepSeek V4.1 Flash (default) | `deepseek-v4.1-flash` | Text, image | $0.20 / $0.006 / $0.60 |
| GLM-5.3-Flash | `glm-5.3-flash` | Text, image | $0.15 / $0.05 / $0.50 |
| Kimi K3 2.8T | `kimi-k3` | Text, image | $2.50 / $0.25 / $10.95 |
| Claude Opus 5.5 | `claude-opus-5.5` | Text, image | $4.40 / $0.22 / $22.00 |
| GPT-6 Sol | `gpt-6-sol` | Text, image | $2.20 / $0.22 / $11.00 |
| GPT-6 Luna | `gpt-6-luna` | Text, image | $0.11 / $0.011 / $0.55 |

The prices match the pinned [OpenRouter endpoints](https://openrouter.ai/api/v1/endpoints/zdr): the first three on 2026-09-18, the last three on 2026-09-23. All rates exclude Kortix credit markup.

The OpenCode reference is `kortix/<gateway model ID>`. The bundled sandbox fallback uses the same IDs and capabilities. All entries require `OPENROUTER_API_KEY`.

DeepSeek V4.1 Flash uses `deepinfra/fp8`; Kimi K3 uses `wafer`; GLM-5.3-Flash uses `coreweave/nvfp4`; Claude Opus 5.5 uses `amazon-bedrock/us-east-1`; GPT-6 Sol and GPT-6 Luna use `azure/us`. Every route sets `zdr: true`, `data_collection: deny`, and `allow_fallbacks: false`. The DeepSeek, GLM, and Kimi model/endpoint pairs appeared in OpenRouter's ZDR endpoint feed on 2026-09-18. Kimi K3 returned HTTP 200 for text and image requests on the pinned Wafer route. On 2026-09-18, pinned GLM requests returned HTTP 429 `rate_limit_exceeded` from CoreWeave's shared pool. DeepSeek V4.1 Flash remains the default until a pinned GLM text and image request succeeds with the deployment key.

### Claude Opus 5.5, GPT-6 Sol, and GPT-6 Luna

All three were released on 2026-09-22. On 2026-09-23 each model/endpoint pair was in OpenRouter's ZDR endpoint feed, and each pinned request with the deployment key returned HTTP 200 for a text prompt, a 128 × 128 red PNG (answer: "red"), and a tool call.

- Each pin is a US region: Azure `azure/us` and Bedrock `us-east-1`. The global Azure endpoint is $2.00 / $10.00 for Sol, and the global Bedrock and Vertex endpoints are $4.00 / $20.00 for Opus. Their region is not stated, so they are excluded. Opus 5.5 on Vertex `google-vertex/us` also passed all three requests at $4.40 / $22.00; Bedrock `us-east-1` is pinned because it names one region.
- GPT-6 Sol and Luna bill a higher tier from 272,000 prompt tokens: Sol $4.40 / $0.44 / $16.50, Luna $0.22 / $0.022 / $0.825. Cache writes cost $2.75 (Sol), $0.1375 (Luna), and $5.50 (Opus).
- Opus 5.5 on Bedrock accepts `tool_choice` `auto` and `none`, not `required`. A forced tool call with reasoning returns HTTP 400. OpenCode sends `auto`.
- No pinned endpoint honors a client `temperature`. OpenRouter drops the field; with `require_parameters` no endpoint matches. The sandbox fallback therefore advertises `temperature: false`.
- Context: 1,050,000 tokens (GPT-6; 922,000 input) and 1,000,000 (Opus 5.5), each with 128,000 output tokens.

`CATALOG` carries the models.dev records for `openai/gpt-6-sol`, `openai/gpt-6-luna`, `anthropic/claude-opus-5-5`, and their three OpenRouter ids. The served catalog takes reasoning effort and modalities from them: `none` to `max` for GPT-6, `low` to `max` for Opus 5.5.

The ChatGPT subscription lineup (`codex/<id>`, `apps/api/src/llm-gateway/models/codex-models.ts`) also offers `gpt-6-sol` and `gpt-6-luna`.

The public Morph feed lists a different GLM-5.3-Flash endpoint (`morph-glm53flash`) at $0.10 / $0.02 / $0.35. On 2026-09-17, the supplied Morph key received HTTP 400 `invalid_request_error` for that ID. MiniMax M3 and Qwen 3.8 27B are absent from that feed and returned HTTP 400. GLM-5.3 744B accepts only text input and is excluded.

DeepSeek V4 Flash 0731 and DeepSeek V4 Pro 0813 remain excluded. DeepSeek reports that V4.1 Flash supersedes V4 Pro for performance, cost, speed, and task completion.

GLM-5.3-FlashX remains excluded. On 2026-09-21, OpenRouter listed one `z-ai/fp8` endpoint. The endpoint was ZDR and multimodal, but its provider region was Singapore. Pinned text and image requests also returned HTTP 429. This route does not meet the US inference residency requirement.

Qwen3.8 Max 0902 remains excluded. On 2026-09-21, OpenRouter listed one `alibaba` endpoint at $2.00 / $0.25 / $6.00 per million input / cached input / output tokens. The endpoint supports text, image, and video with a 1,000,000-token context window. It was absent from the account's ZDR endpoint feed, and pinned text and image requests returned HTTP 404 because no endpoint matched the ZDR policy. OpenRouter reported Alibaba datacenters only in Singapore and China. This route meets neither the ZDR nor US inference residency requirement.

## Catalog

`CATALOG` is the bundled models.dev snapshot. It lives in `src/catalog-data.ts`, not in `index.ts`, so a bundler drops the ~7.6 MB JSON for consumers that never read `CATALOG` or `catalogModelForWireModel`. `MANAGED_MODELS` contains the managed lineup. `PLATFORM_DEFAULT_MODEL_ID` is `deepseek-v4.1-flash`. The runtime catalog refreshes from the configured models.dev URL.

## License

Elastic-2.0.
