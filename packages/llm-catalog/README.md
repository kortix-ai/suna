# @kortix/llm-catalog

This package supplies the bundled provider catalog and the Kortix managed model lineup. The API owns runtime routing and the live served catalog.

## Managed models

Kimi K3 (`kimi-k3`) left the lineup on 2026-10-19. A session or default that names it runs on DeepSeek V4.1 Flash (`LEGACY_MANAGED_IDS`).

The picker groups every managed model under **Kortix**, and the provider is always Kortix. Requests use Kortix credits. Project BYOK providers remain separate.

| Picker name | Gateway model ID | OpenRouter model ID | Input | Displayed USD per 1M input / cached input / output tokens |
| --- | --- | --- | --- | --- |
| DeepSeek V4.1 Flash (default) | `deepseek-v4.1-flash` | `deepseek/deepseek-v4.1-flash-1017` | Text, image | $0.20 / $0.03 / $0.65 |
| GLM-5.3-Flash | `glm-5.3-flash` | `z-ai/glm-5.3-flash` | Text, image | $0.15 / $0.05 / $0.50 |

The displayed prices are the OpenRouter pool prices, or the pool cap for GLM. OpenRouter requests bill its reported `usage.cost`. Direct Morph requests use the separate Morph prices in `MANAGED_MODELS`. All rates exclude Kortix credit markup.

The OpenCode reference is `kortix/<gateway model ID>`. The bundled sandbox fallback (`MINIMAL_FALLBACK_MODELS`) uses the same IDs, prices, and capabilities.

### Routing: Morph direct, then Zen, then the OpenRouter pool

DeepSeek V4.1 Flash and GLM-5.3-Flash try their upstreams in this order (`managedCandidates`). OpenRouter is last. Any failed attempt (an HTTP error, a network error, the 90 s header timeout, or an error frame in the first 10 s of a stream) moves the request to the next one. After the last one fails, the platform fallback policy moves the request to the other managed model: `deepseek-v4.1-flash` falls back to `glm-5.3-flash` and back (`LLM_GATEWAY_FALLBACK_POLICIES`, `policy-config.ts`). `codex/gpt-5.6-sol` falls back to both, in that order.

| Order | Upstream | Selected by | Default |
| --- | --- | --- | --- |
| 1 | Morph direct (signed ZDR terms) | `MORPH_MANAGED_MODELS` + `MORPH_API_KEY` | `deepseek-v4.1-flash,glm-5.3-flash` |
| 2 | OpenCode Zen | `OPENCODE_ZEN_MANAGED_MODELS` + `OPENCODE_ZEN_API_KEY` | `glm-5.3-flash,deepseek-v4.1-flash` |
| 3 | OpenRouter endpoint pool | the model's `openrouterProvider.only` + `OPENROUTER_API_KEY` | every managed model |

Why: from 2026-10-16 22:00 to 2026-10-19 04:00 UTC, DeepSeek had one upstream, the OpenRouter pool pinned to `coreweave/fp8`. That endpoint answered 60 to 80% of requests with HTTP 429 (`limit_source: upstream_provider_shared_pool`). OpenRouter's uptime page showed it at 100% the whole time: its uptime does not count shared-pool 429s.

Measured on 2026-10-19 with the prod keys, ~150k-token prompts, streaming, one tool call (first token p50 / max, all requests answered with a tool call):

| Route | DeepSeek V4.1 Flash, 8 parallel | DeepSeek, 40 parallel | GLM-5.3-Flash, 8 parallel | GLM, 40 parallel | Kimi K3, 8 parallel |
| --- | --- | --- | --- | --- | --- |
| Morph direct | 2.9 s / 3.2 s (1017 snapshot) | 8.0 s / 10.8 s, 40/40 | 7.9 s / 8.2 s | 11.3 s / 12.6 s, 40/40 | 34.5 s / 34.7 s |
| OpenRouter `morph/fp8` | 5.4 s / 5.9 s (1017 snapshot) | not measured | not measured | not measured | — |
| OpenRouter `fireworks/us` | — | — | — | — | 10.0 s / 12.2 s |
| OpenCode Zen | 12.9 s / 16.6 s | 10.5 s / 18.7 s, 40/40 | 9.8 s / 12.0 s | not measured | 11.3 s / 28.7 s |

1. An empty `MORPH_MANAGED_MODELS` or `OPENCODE_ZEN_MANAGED_MODELS` removes that upstream for every managed model (the kill switch). The change takes effect after an API restart or deployment.
2. The gateway fails over on an error and on the 90 s header timeout, never on a slow first token. Direct Morph was off from 2026-09-27 to 2026-10-19 for that reason (p90 67 s then).
3. A Free account may use only the platform default. It may also use the platform policy's fallback model, as that fallback only (`isPlatformDefaultFallback` in `resolve-candidates.ts`). On 2026-10-17 and 10-18, 119 Free accounts got DeepSeek's 429 on 8,469 requests with no fallback.
4. OpenRouter routes inside the model's endpoint pool: `only` lists the pool, `allow_fallbacks: true` lets OpenRouter move to the next pool member on an endpoint error, `zdr: true` and `data_collection: deny` are forced by the gateway, and `max_price` (USD per 1M tokens) excludes premium tiers. The gateway intersects operator-defined pools with the verified US endpoint list.
5. The OpenRouter model ID names the model author, not the inference host. The allowlist names the permitted hosts.

A failure after output has started is not retried. The client receives the stream error.

Billing uses OpenRouter's reported `usage.cost` for the endpoint that served the request, within the configured `max_price`. A direct Morph request uses its separate Morph list prices.

The project model picker lists each eligible managed route's estimated customer price for input, cached input, and output tokens. The API refreshes allowed OpenRouter endpoint rates from its endpoint API at most once every five minutes. A feed failure keeps the verified public rate table. The API applies `KORTIX_LLM_MARKUP` (default `1.2`) before returning prices. OpenRouter may select any allowed endpoint; its reported `usage.cost` determines the settled charge. Direct Morph rates use the public table until updated in the catalog. The fallback tables were checked against [OpenRouter's model endpoint pages](https://openrouter.ai/docs/api/api-reference/endpoints/list-all-endpoints-for-a-model) and [Morph's current pricing](https://www.morphllm.com/pricing) on 2026-09-26.

For a quick route change, set `MORPH_MANAGED_MODELS` in the deployment environment and restart the API. For example, `MORPH_MANAGED_MODELS=deepseek-v4.1-flash` limits Morph to DeepSeek. Set `MORPH_MANAGED_MODELS=` to disable Morph globally. Direct Morph does not inherit OpenRouter's ZDR controls: Kortix has signed ZDR terms with Morph directly (2026-10-19).

Without `OPENROUTER_API_KEY`, GLM is unavailable by default. Other selected models require `MORPH_API_KEY` or `OPENROUTER_API_KEY`.

### OpenCode Zen

`OPENCODE_ZEN_MANAGED_MODELS` lists the managed model IDs that [OpenCode Zen](https://opencode.ai/docs/zen) serves after Morph direct and before the OpenRouter pool. Its default is `glm-5.3-flash,deepseek-v4.1-flash`. The candidate exists only when `OPENCODE_ZEN_API_KEY` is set. An empty list is the kill switch. `OPENCODE_ZEN_API_URL` defaults to `https://opencode.ai/zen/v1`.

1. Zen states that its providers keep zero data retention. The exceptions are OpenAI, Anthropic, and free models. No managed model is one of them.
2. Zen serves the managed IDs unchanged (`glm-5.3-flash`, `kimi-k3`, `deepseek-v4.1-flash`) on `/chat/completions`.
3. The gateway sends `x-opencode-session` (the Kortix session) and `User-Agent: Kortix (https://kortix.com)`. Zen refuses a request without the session header.
4. Zen sends no `usage.cost`. The gateway bills the model's managed `pricing`, the same rate the picker shows.
5. `usage_events.metadata.upstreamProvider` is `opencode` for a request that Zen served. The client sees only Kortix.

Why: from 2026-09-22 to 2026-09-29, 0.7% of prod GLM requests (287 of 40,861) returned `429 model_busy`. OpenRouter reported `limit_source: upstream_provider_shared_pool`: Decart and CoreWeave serve non-BYOK traffic from a pool shared with every OpenRouter customer. The 429 rate did not rise with Kortix load (1.1% at under 20 requests per minute, 0.2% at 200 or more). `fireworks/us` returned 429 on every probe on 2026-09-29, so it adds no capacity. Zen is capacity outside that shared pool.

Why first, measured on 2026-09-29 at the prod request shape (about 160k-token prompts, 4 turns per session, cached follow-ups):

| Route | Concurrent sessions | Result |
| --- | --- | --- |
| Zen | 60 | 239 of 240 OK, 404 requests/min, 65.7M input tokens/min, 96% cache hits, first token p50 3.7 s |
| Zen | 120 | 37% HTTP 429 |
| OpenRouter pool (Decart, CoreWeave) | 60 | 167 OK, 17 HTTP 429, 56 timeouts; 43 requests/min, 74% cache hits |

Prod GLM peaked at 262 requests/min and 37M input tokens/min on 2026-09-29.

### OpenRouter endpoint pools

The rule is ZDR, not location. Every pool member is in OpenRouter's ZDR feed (`/api/v1/endpoints/zdr`), and every request also sends `zdr: true` and `data_collection: 'deny'`, so a member that loses ZDR status is skipped. Kortix makes no US-datacenter claim for managed inference.

A member must also have passed, on 2026-10-19 through OpenRouter pinned to that one endpoint: 12 of 12 requests (6 `read_file` tool calls with a ~30k-token context, 6 exact arithmetic answers), 3 of 3 image reads, a first-token p50 under 6 s, and input, cached-input and output prices at or below the model's `pricing`.

The gateway sends a request to a member only when its host is a subprocessor in effect (`inferenceHostCleared` in `@kortix/shared/subprocessors`, by the row's `inferenceHosts`). A host joins on its notice date without a code change.

| Model | Member | Host may serve |
| --- | --- | --- |
| DeepSeek V4.1 Flash (1017) | `deepinfra/fp8`, `deepinfra/fp8/priority` | from 2026-11-24 |
| | `inference-net/fp8`, `wafer/mxfp4` | after a subprocessor row + 37 days |
| | `cloudflare` | after its subprocessor row lists inference |
| GLM-5.3-Flash | `fireworks` | now |
| | `deepinfra/fp4`, `together`, `parasail/fp4`, `modal/nvfp4` | from 2026-11-24 |
| | `crusoe/fp4`, `inference-net/fp4`, `makora`, `near-ai/fp8`, `open-inference/fp4`, `primeintellect`, `siliconflow/fp8`, `venice` | after a subprocessor row + 37 days |

Until 2026-11-24, DeepSeek has no OpenRouter member a request may reach: Zen and Morph direct serve it, and GLM is its fallback model. `morph/fp8` is not a member: Morph is already the direct route.

Excluded on 2026-10-19:
- **429 from a shared pool on most requests:** `coreweave/nvfp4` (GLM, 3 of 12), `decart/fp4` (DeepSeek, 0 of 12; no longer in the GLM ZDR feed), `baseten`, `baseten/fp8`, `baseten/fp8/us`, `parasail/fast`.
- **Wrong output:** `relace` (GLM: garbled text, 1 of 12; DeepSeek: 1 of 3 images).
- **Image input refused:** `digitalocean` (HTTP 400), `sail-research/us` and `sail-research/fp4` (HTTP 404).
- **Above the model's price:** for DeepSeek, `fireworks`, `together`, `crusoe/fp8`, `primeintellect`, `parasail/fp8`, `baseten` ($0.30 / $1.20); for GLM, `wafer/nvfp4` (cached), `inceptron/fp8` and `reka` (output), `fireworks/us`, `morph/fp8`.
- **Slow (first-token p50 over 6 s):** `deepinfra/fp8/flex` (DeepSeek), `z-ai/fp8`, `novita/fp8`, `phala/nvfp4`, `nextbit/fp4` (GLM).
- **Not in the ZDR feed:** `deepseek`, `alibaba`, `atlas-cloud/fp8`, `streamlake/fp8`, `gmicloud/fp8`, `friendli`.

Known limits:
- A prompt such as "Reply with exactly: X" makes DeepSeek V4.1 Flash break mid-word on several hosts (Morph, DeepInfra, Together), from 11 to 17 of 20 exact. Tool calls and ordinary answers were 60 of 60 on each route tested.
- `fp4`, `nvfp4` and `mxfp4` members run 4-bit weights; `fp8` members run 8-bit. All passed the same probes.

### Why GLM-5.3-Flash failed before 2026-09-24

The route pinned one endpoint (`only: ['coreweave/nvfp4']`, `allow_fallbacks: false`). CoreWeave serves OpenRouter's non-BYOK traffic from a shared pool. On 2026-09-24 that pool returned HTTP 429 `rate_limit_exceeded` (`limit_source: upstream_provider_shared_pool`) for 11 of 15 requests that OpenRouter routed to it. With a single pin and no fallback, every such 429 reached the user. The same 429 was recorded on 2026-09-18.

### Context windows

Every managed model publishes `limit: { context: 1_000_000, output: 16_384 }`. OpenCode compacts a session after a step that used `context - min(output, 32_000)` tokens, which is 983,616. It sends `max_tokens` = 16,384.

Measured on 2026-09-30 with synthetic prompts at the edge of each window:

| Model | Route | Largest request accepted | Check | Overflow reply |
| --- | --- | --- | --- | --- |
| GLM-5.3-Flash | Zen | prompt 1,048,573 | prompt only | HTTP 400 "The prompt is too long" |
| GLM-5.3-Flash | OpenRouter `decart/fp4` | prompt + `max_tokens` 1,048,576 | combined | HTTP 200, then an in-band 400 frame |
| GLM-5.3-Flash | OpenRouter `coreweave/nvfp4` | prompt + `max_tokens` 1,048,576 | combined | HTTP 400 "combined input and output tokens" |
| GLM-5.3-Flash | Morph | prompt 1,036,630 with `max_tokens` 16 | combined | HTTP 400 "Invalid request" |
| DeepSeek V4.1 Flash | Morph | prompt 1,047,041 with `max_tokens` 16 | combined | HTTP 400 "Invalid request" |
| DeepSeek V4.1 Flash 1017 | OpenRouter `morph/fp8` | prompt 1,032,008 + `max_tokens` 16,384 (2026-10-18) | combined | HTTP 400 "Invalid request" |
| Kimi K3 | OpenRouter `fireworks/us` | prompt 1,048,575 | prompt only | HTTP 400 "prompt is too long" |
| Kimi K3 | Morph | not measured: HTTP 429 `service_overloaded` on every probe | | |

A route that checks prompt + `max_tokens` rejects a prompt above 1,032,192. The 48,576-token gap between the compaction point and that limit is the room one more step has: a new message plus tool results. `src/managed.test.ts` fails when a managed model's `limit` leaves less than 32,768 tokens, or when a managed model has no measured window.

The gateway answers every rejection above as HTTP 400 `context_length_exceeded`, including OpenRouter's in-band frame: an error as the first `data:` frame of a direct stream is a failed attempt, not a response (`packages/llm-gateway/src/http/call-upstream.ts`). OpenCode reads that code as a context overflow and compacts. A managed candidate fails over on any error, so Morph's unexplained 400 moves the request to the next route, whose reply explains it.

Before 2026-09-30 the limit was 1,048,576. OpenCode compacted only at 1,032,192, which is where the combined routes reject, and OpenRouter's in-band rejection reached OpenCode as an `UnknownError`. A trigger that re-prompted one GLM session every few minutes failed every turn with `context_length_exceeded`.

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
