# @kortix/llm-catalog

The Kortix build-time compatibility catalog — managed-model constants and a
bundled [models.dev](https://models.dev) snapshot used by SDK/web releases and as
the API's last-known fallback. Runtime gateway routing and the live served model
catalog are owned by `apps/api/src/llm-gateway`; the standalone gateway does not
depend on this package. This package is consumed by the API, web, and
[`@kortix/sdk`](https://www.npmjs.com/package/@kortix/sdk).

It ships to npm in lockstep with the platform release version, so a given
`@kortix/sdk@x.y.z` always resolves `@kortix/llm-catalog@x.y.z`.

## Usage

```ts
import {
  CATALOG,
  MANAGED_MODELS,
  DEFAULT_MANAGED_MODEL_IDS,
  MANAGED_FLAGSHIP_MODEL_ID,
  PLATFORM_DEFAULT_MODEL_ID,
  getManagedModel,
  isManagedModelId,
} from '@kortix/llm-catalog';
```

- `CATALOG` — bundled provider/model snapshot used until the API refreshes from its configured catalog URL.
- `MANAGED_MODELS` / `getManagedModel` / `isManagedModelId` — the managed model set.
- `DEFAULT_MANAGED_MODEL_IDS`, `MANAGED_FLAGSHIP_MODEL_ID` — managed-model defaults.
- `PLATFORM_DEFAULT_MODEL_ID` — the concrete platform fallback model.

## GPT-6 Astra

Select **GPT-6 Astra** under **Kortix** in the session model picker. Project
owners can enable it in **Models** and select it as the project default.
The managed model uses Kortix credits through OpenRouter's OpenAI endpoint.
The gateway model ID is `gpt-6-astra`; the OpenCode reference is
`kortix/gpt-6-astra`.

Astra supports image input, tool calls, and reasoning levels `low`, `medium`,
`high`, `xhigh`, and `max`. Its context window is 1,050,000 tokens, with up to
128,000 output tokens. Temperature and `none` reasoning are unsupported.

The catalog includes Astra's standard and above-272,000-token pricing from
[OpenAI](https://developers.openai.com/api/docs/models/gpt-6-astra).
The sandbox fallback carries the same capabilities when the live catalog is
unavailable. The platform default remains DeepSeek V4 Flash.

## License

Elastic-2.0.
