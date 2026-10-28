# @kortix/llm-catalog

This package supplies the bundled provider catalog (the models.dev snapshot) and the shared catalog helpers. It holds no Kortix managed model: the API owns runtime routing, the live served catalog, and the managed lineup.

## Kortix managed models: Platinum Inference

Kortix managed models are a provider like any other, Platinum Inference, paid from Kortix credits. The lineup is whatever Platinum lists at `GET {PLATINUM_INFERENCE_URL}/models`: id, name, limits, image input, reasoning efforts and price per 1M tokens. The API reads it at boot and every 5 min (`loadManagedLineup` in `apps/api/src/llm-gateway/models/managed-models.ts`, `workers/managed-lineup-worker.ts`). A model Platinum adds or reprices reaches users with no Kortix change.

1. Every managed model has one upstream, Platinum (`managedCandidates` in `apps/api/src/llm-gateway/resolution/descriptors.ts`), reached with `PLATINUM_INFERENCE_API_KEY` (`pt_live_`, scope `inference`). Without the key, or with `KORTIX_MANAGED_PROVIDER_ENABLED` off, no managed model is listed, offered or served.
2. Platinum owns the upstreams, their order, failover and their zero-data-retention terms.
3. The gateway sends `x-platinum-session` (the Kortix session, else the API key, else the user). Platinum keys upstream prompt caches by it.
4. Platinum reports its charge as `usage.cost` (USD). The gateway bills that cost × `KORTIX_LLM_MARKUP` (default `1.055`). The listed price applies only to a response without `usage.cost`.
5. `usage_events.metadata.upstreamProvider` is `platinum`. The client sees only Kortix.
6. The platform default is `LLM_GATEWAY_DEFAULT_MODEL` when Platinum serves it, else the first model Platinum lists. Model-level fallback (`LLM_GATEWAY_FALLBACK_POLICIES`, `policy-config.ts`) is unchanged.
7. Every client treats a bare model id under the gateway provider (`kortix/<id>`) as managed. No client holds a list of managed ids.

Retired ids that stored sessions may still carry (`LEGACY_MANAGED_IDS`, `RETIRED_MANAGED_MODEL_IDS`) stay in the API, so an old session moves to its successor.

The gateway answers every overflow as HTTP 400 `context_length_exceeded`, including an error as the first `data:` frame of a stream (`packages/llm-gateway/src/http/call-upstream.ts`). OpenCode reads that code as a context overflow and compacts.

## Catalog

`CATALOG` is the bundled models.dev snapshot. It lives in `src/catalog-data.ts`, not in `index.ts`, so a bundler drops the ~7.6 MB JSON for consumers that never read `CATALOG` or `catalogModelForWireModel`. The runtime catalog refreshes from the configured models.dev URL.

## License

Apache-2.0.
