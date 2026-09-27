import { describe, expect, test } from 'bun:test';
import { MANAGED_MODELS } from '@kortix/llm-catalog';

// The sandbox daemon's LAST-RESORT managed set. It is what OpenCode's `kortix`
// provider registers when the box has a stale baked catalog AND the live
// managed fetch (`GET /models?scope=managed`) fails — i.e. the floor under the
// 2026-08-19 outage, where OpenCode answered `ModelNotFound: kortix/grok-4.6`
// for a managed model the API had been serving since 2026-08-13.
//
// Imported across app boundaries ON PURPOSE: this file is the tripwire that
// fails the moment the managed lineup and that hand-maintained table drift.
import { BUNDLED_MANAGED_MODELS } from '../../../../kortix-sandbox-agent-server/src/harness/open-code/lifecycle';

const managedIds = MANAGED_MODELS.map((m) => m.id).sort();
const bundledIds = Object.keys(BUNDLED_MANAGED_MODELS).sort();

describe('daemon bundled managed set vs the managed lineup', () => {
  // Both directions matter. A served model missing from the fallback answers
  // ModelNotFound; a fallback entry the lineup dropped resolves as
  // model_not_found and 400s every turn that selects it.
  test('the daemon fallback lists exactly the @kortix/llm-catalog managed lineup', () => {
    expect(bundledIds).toEqual(managedIds);
  });

  test('every bundled managed entry is branded as a Kortix-managed bare id', () => {
    for (const [id, model] of Object.entries(BUNDLED_MANAGED_MODELS)) {
      expect(id).not.toInclude('/');
      expect(model.provider).toBe('kortix');
      expect(model.limit?.context).toBeGreaterThan(0);
    }
  });

  // The fallback record is what OpenCode registers when the live fetch is down,
  // so each field the runtime or the picker reads must equal the lineup's.
  for (const managed of MANAGED_MODELS) {
    test(`${managed.id}: name, limit, vision, tool calling, and declared cost agree`, () => {
      const bundled = BUNDLED_MANAGED_MODELS[managed.id];
      expect(bundled).toBeDefined();
      if (!bundled) return;
      expect(bundled.name).toBe(managed.name);
      // `limit` sizes the conversation; a drift compacts at the wrong wall.
      expect(bundled.limit).toEqual(managed.limit);
      expect(bundled.attachment ?? false).toBe(managed.vision);
      // The managed lineup is tool-capable; an agent turn needs tool calls.
      expect(bundled.tool_call).toBe(true);
      // Cost is optional on the fallback record; when declared it must be the
      // billed rate the picker renders.
      if (bundled.cost && managed.pricing) {
        expect(bundled.cost.input).toBe(managed.pricing.inputPerMillion);
        expect(bundled.cost.output).toBe(managed.pricing.outputPerMillion);
        if (bundled.cost.cache_read !== undefined) {
          expect(bundled.cost.cache_read).toBe(managed.pricing.cachedInputPerMillion ?? Number.NaN);
        }
      }
    });
  }
});
