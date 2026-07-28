import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { seedDraft } from './policies-panel';

// Regression test for the Better Stack error pattern `236e88fb…` —
//   `TypeError: Cannot read properties of undefined (reading 'map')`
// thrown from the project layout's global-view render path
// (`/projects/:id?c=global` → `GlobalRulesPanel` → `PoliciesPanel`). The seeding
// `useEffect` previously did `query.data.policies.map(...)` after only guarding
// `query.data` itself; a `listProjectPolicies` response with a missing/`null`
// `policies` field (empty/new project, backend shape gap, partial response)
// slipped past `if (!query.data) return` and `.policies.map` threw. The fix
// centralizes seeding in the pure `seedDraft` helper with `policies ?? []` +
// `defaultMode ?? 'allow_all'` defaults. Mirrors the chunk-22256 `toArray()`
// guard (#4542).

const panelSource = readFileSync(
  fileURLToPath(new URL('./policies-panel.tsx', import.meta.url)),
  'utf8',
);

describe('seedDraft — guards the PoliciesPanel seeding path against a missing policies field', () => {
  test('does NOT throw on the exact prod failure shape: truthy data, undefined policies + defaultMode', () => {
    // The exact shape that fired in prod: a truthy `data` object whose `policies`
    // and `defaultMode` fields are missing. The old `useEffect` threw here.
    const result = seedDraft({ policies: undefined, defaultMode: undefined });
    expect(() => seedDraft({ policies: undefined, defaultMode: undefined })).not.toThrow();
    expect(result.draft).toEqual([]);
    expect(result.defaultMode).toBe('allow_all');
    // Signature must be `[]`-stable, not `{"policies":null,...}` (JSON.stringify
    // turns `undefined` into `null`, which a subsequent save could write back).
    expect(result.serverSig).toBe(JSON.stringify({ policies: [], defaultMode: 'allow_all' }));
  });

  test('absorbs a null policies field (another valid HTTP outcome)', () => {
    const result = seedDraft({ policies: null, defaultMode: null });
    expect(result.draft).toEqual([]);
    expect(result.defaultMode).toBe('allow_all');
    expect(result.serverSig).toBe(JSON.stringify({ policies: [], defaultMode: 'allow_all' }));
  });

  test('happy path: maps valid policies and preserves defaultMode', () => {
    const result = seedDraft({
      policies: [{ match: 'stripe.charges.create', action: 'require_approval' }],
      defaultMode: 'risk',
    });
    expect(result.draft).toHaveLength(1);
    expect(result.draft[0]).toMatchObject({
      match: 'stripe.charges.create',
      action: 'require_approval',
    });
    expect(typeof result.draft[0].id).toBe('string');
    expect(result.defaultMode).toBe('risk');
    expect(result.serverSig).toBe(
      JSON.stringify({
        policies: [{ match: 'stripe.charges.create', action: 'require_approval' }],
        defaultMode: 'risk',
      }),
    );
  });

  test('happy path: empty policies array is preserved (not coerced away)', () => {
    const result = seedDraft({ policies: [], defaultMode: 'allow_all' });
    expect(result.draft).toEqual([]);
    expect(result.defaultMode).toBe('allow_all');
    expect(result.serverSig).toBe(JSON.stringify({ policies: [], defaultMode: 'allow_all' }));
  });
});

// Source-level guard (same convention as chunk22256-guard.test.ts): keep a
// future refactor from silently restoring an unguarded `query.data.policies.map`
// in either the seeding `useEffect` or the `revert` handler.
describe('PoliciesPanel source guard — no unguarded query.data.policies.map', () => {
  test('the seeding useEffect + revert handler route through seedDraft, not raw .policies.map', () => {
    expect(panelSource).not.toContain('query.data.policies.map(');
    expect(panelSource).toContain('seedDraft(query.data)');
  });
});
