# @kortix/llm-catalog

The Kortix LLM model catalog — the set of models the Kortix gateway supports,
the managed-model set and defaults, and the auto-model picker. The catalog data
(`catalog.generated.json`) is generated from [models.dev](https://models.dev) and
consumed across the Kortix platform (gateway, API, web) and by
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

- `CATALOG` — the full generated model catalog (providers → models).
- `MANAGED_MODELS` / `getManagedModel` / `isManagedModelId` — the managed model set.
- `AUTO_MODEL_ID`, `DEFAULT_MANAGED_MODEL_IDS`, `MANAGED_FLAGSHIP_MODEL_ID` — defaults.
- `pickAutoModel(...)` — the "auto" model resolution helper.

## License

Elastic-2.0.
