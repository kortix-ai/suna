# @kortix/llm-catalog

This package supplies the bundled provider catalog and the Kortix managed model lineup. The API owns runtime routing and the live served catalog.

## Managed models

The managed lineup uses OpenRouter routes pinned to named zero-data-retention endpoints. The model picker groups every managed model under **Kortix**. Requests use Kortix credits. Project BYOK providers remain separate.

| Picker name | Gateway model ID | Input | USD per 1M input / cached input / output tokens |
| --- | --- | --- | --- |
| DeepSeek V4.1 Flash (default) | `deepseek-v4.1-flash` | Text, image | $0.20 / $0.006 / $0.60 |
| DeepSeek V4 Pro 0813 | `deepseek-v4-pro-0813` | Text | $0.70 / $0.033 / $2.96 |
| GLM-5.3-Flash | `glm-5.3-flash` | Text, image | $0.15 / $0.05 / $0.50 |
| Kimi K3 2.8T | `kimi-k3` | Text, image | $2.50 / $0.25 / $10.95 |

The prices match the pinned [OpenRouter endpoints](https://openrouter.ai/api/v1/endpoints/zdr) on 2026-09-18. All rates exclude Kortix credit markup.

The OpenCode reference is `kortix/<gateway model ID>`. The bundled sandbox fallback uses the same IDs and capabilities. All entries require `OPENROUTER_API_KEY`.

DeepSeek V4.1 Flash uses `deepinfra/fp8`; DeepSeek V4 Pro 0813 uses `sail-research/us`; Kimi K3 uses `wafer`; GLM-5.3-Flash uses `coreweave/nvfp4`. Every route sets `zdr: true`, `data_collection: deny`, and `allow_fallbacks: false`. All four exact model/endpoint pairs appeared in OpenRouter's ZDR endpoint feed on 2026-09-18. The Sail Research US route returned HTTP 200 with the dev key and has a 1,048,576-token context window. Kimi K3 returned HTTP 200 for text and image requests on the pinned Wafer route. On 2026-09-18, pinned GLM requests returned HTTP 429 `rate_limit_exceeded` from CoreWeave's shared pool. DeepSeek V4.1 Flash remains the default until a pinned GLM text and image request succeeds with the deployment key.

The public Morph feed lists a different GLM-5.3-Flash endpoint (`morph-glm53flash`) at $0.10 / $0.02 / $0.35. On 2026-09-17, the supplied Morph key received HTTP 400 `invalid_request_error` for that ID. MiniMax M3 and Qwen 3.8 27B are absent from that feed and returned HTTP 400. GLM-5.3 744B accepts only text input and is excluded.

DeepSeek V4 Flash 0731 remains excluded. DeepSeek V4 Pro 0813 is text-only; the picker shows no image capability for it.

## Catalog

`CATALOG` is the bundled models.dev snapshot. `MANAGED_MODELS` contains the managed lineup. `PLATFORM_DEFAULT_MODEL_ID` is `deepseek-v4.1-flash`. The runtime catalog refreshes from the configured models.dev URL.

## License

Elastic-2.0.
