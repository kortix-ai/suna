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
  AUTO_MODEL_ID,
  DEFAULT_MANAGED_MODEL_IDS,
  MANAGED_FLAGSHIP_MODEL_ID,
  getManagedModel,
  isManagedModelId,
  pickAutoModel,
} from '@kortix/llm-catalog';
```

- `CATALOG` — bundled provider/model snapshot used until the API refreshes from its configured catalog URL.
- `MANAGED_MODELS` / `getManagedModel` / `isManagedModelId` — the managed model set.
- `AUTO_MODEL_ID`, `DEFAULT_MANAGED_MODEL_IDS`, `MANAGED_FLAGSHIP_MODEL_ID` — defaults.
- `pickAutoModel(...)` — compatibility helper for SDK/client code; runtime routing is control-plane-owned.

## License

Elastic-2.0.
