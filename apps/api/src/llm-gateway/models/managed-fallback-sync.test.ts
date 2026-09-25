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
});
