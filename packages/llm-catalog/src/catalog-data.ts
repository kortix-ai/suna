import catalogJson from './catalog.generated.json' with { type: 'json' };
import type { Catalog, CatalogModel } from './lite';

/**
 * The bundled models.dev snapshot. Kept out of `index.ts` so consumers that
 * never read it (browser bundles) do not ship it — see
 * catalog-isolation.test.ts.
 */
export const CATALOG = catalogJson as Catalog;

function modelsByWireId(catalog: Catalog): Map<string, CatalogModel> {
  const byId = new Map<string, CatalogModel>();
  for (const provider of catalog.providers) {
    for (const model of provider.models) byId.set(`${provider.id}/${model.id}`, model);
  }
  return byId;
}

/**
 * Resolve a gateway WIRE model id to its full `CatalogModel` — the capability
 * record `generationControlCapabilities`/`clampGenerationConfig` gate against.
 * The CANONICAL wire-id → model resolver: it stitches together the three id
 * shapes a gateway request can carry, so a caller never has to string-split
 * `<provider>/<model>` or special-case managed slugs itself.
 *
 *   - `codex/<id>`      → the genuine OpenAI catalog entry (`openai/<id>`).
 *   - `<provider>/<id>` → that provider's catalog entry (BYOK models).
 *   - bare `<id>`       → a Kortix managed model; not in this catalog. apps/api
 *                         answers it from the live Platinum lineup.
 *
 * `catalog` defaults to the bundled static `CATALOG`. apps/api passes the LIVE
 * models.dev snapshot instead (its own thin wrapper of the same name) so the
 * host-side generation-controls clamp sees fresh capabilities; the standalone
 * gateway transport, which has no runtime snapshot, uses the bundled catalog.
 */
export function catalogModelForWireModel(
  wireModel: string,
  catalog: Catalog = CATALOG,
): CatalogModel | undefined {
  if (wireModel.startsWith('codex/')) {
    return modelsByWireId(catalog).get(`openai/${wireModel.slice('codex/'.length)}`);
  }
  const slash = wireModel.indexOf('/');
  if (slash > 0) {
    const providerId = wireModel.slice(0, slash);
    const modelId = wireModel.slice(slash + 1);
    return catalog.providers
      .find((provider) => provider.id === providerId)
      ?.models.find((model) => model.id === modelId);
  }
  return undefined;
}
