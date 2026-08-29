import { describe, expect, test } from 'bun:test'
import { BUNDLED_MANAGED_MODELS } from '../opencode'

// The bundled managed floor is what OpenCode sees when the live managed fetch
// is down AND the baked image catalog predates a lineup change. A managed
// model missing from it is the exact 2026-08-19 ModelNotFound outage: the
// gateway serves the id, the picker shows it, and every turn on it fails.
// This file is the enforcer that opencode.ts and the learnings register cite.
//
// The catalog is loaded from SOURCE via a dynamic import on purpose:
//  - no package.json dependency — this app is built STANDALONE (see the
//    api-contract note in tsconfig.json; a workspace dep breaks the image build);
//  - no static import — that would pull packages/llm-catalog into this app's
//    tsc program under `noUncheckedIndexedAccess`, which the catalog package
//    does not compile under. Test-only, so the daemon binary is untouched.
interface CatalogManagedModel {
  id: string
  name: string
  vision: boolean
  limit: { context: number; output: number }
  pricing?: { inputPerMillion: number; outputPerMillion: number; cachedInputPerMillion?: number }
}
const catalogSource = new URL('../../../../packages/llm-catalog/src/index.ts', import.meta.url).pathname
const { MANAGED_MODELS } = (await import(catalogSource)) as { MANAGED_MODELS: CatalogManagedModel[] }

describe('BUNDLED_MANAGED_MODELS mirrors @kortix/llm-catalog MANAGED_MODELS', () => {
  test('the catalog loaded', () => {
    expect(MANAGED_MODELS.length).toBeGreaterThan(0)
  })

  test('the same set of ids, in both directions', () => {
    expect(Object.keys(BUNDLED_MANAGED_MODELS).sort()).toEqual(MANAGED_MODELS.map((m) => m.id).sort())
  })

  for (const managed of MANAGED_MODELS) {
    test(`${managed.id}: name, limit, vision, and declared cost agree`, () => {
      const bundled = BUNDLED_MANAGED_MODELS[managed.id]
      expect(bundled, `${managed.id} is missing from MINIMAL_FALLBACK_MODELS`).toBeDefined()
      if (!bundled) return
      expect(bundled.name).toBe(managed.name)
      expect(bundled.provider).toBe('kortix')
      // `limit` is served verbatim to size the conversation; a drift here
      // means one surface compacts at the wrong wall.
      expect(bundled.limit).toEqual(managed.limit)
      expect(bundled.attachment ?? false).toBe(managed.vision)
      // Cost is optional on the fallback record, but when it IS declared it
      // must be the catalog's billed rate — the picker renders it.
      if (bundled.cost && managed.pricing) {
        expect(bundled.cost.input).toBe(managed.pricing.inputPerMillion)
        expect(bundled.cost.output).toBe(managed.pricing.outputPerMillion)
        if (bundled.cost.cache_read !== undefined) {
          expect(bundled.cost.cache_read).toBe(managed.pricing.cachedInputPerMillion ?? Number.NaN)
        }
      }
    })
  }
})
