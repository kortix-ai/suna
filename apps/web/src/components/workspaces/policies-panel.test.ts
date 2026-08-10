import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { seedDraft, toPayloadRule } from './policies-panel';

// Regression test for the Better Stack error pattern `236e88fb…` —
//   `TypeError: Cannot read properties of undefined (reading 'map')`
// thrown from the workspace layout's global-view render path
// (`/projects/:id?c=global` → `GlobalRulesPanel` → `PoliciesPanel`). The seeding
// `useEffect` previously did `query.data.policies.map(...)` after only guarding
// `query.data` itself; a `listWorkspacePolicies` response with a missing/`null`
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

// The panel is rendered inside the Global rules sheet and the customize
// Connectors section, so it has to speak the design-system dialect: hand-composed
// `bg-popover rounded-md border` panels, `kortix-*` accents, named toast helpers.
// Each assertion below pins a primitive that the panel was previously built from
// and that a copy-paste from an older screen would quietly reintroduce.
describe('PoliciesPanel source guard — design-system primitives', () => {
  const imports = panelSource
    .split('\n')
    .filter((line) => line.startsWith('import ') || line.startsWith('  '))
    .join('\n');

  test('no banned wrappers: SectionCard, List/ListRow, Dialog', () => {
    expect(imports).not.toContain("from '@/components/ui/section-card'");
    expect(imports).not.toContain("from '@/components/ui/list'");
    expect(imports).not.toContain("from '@/components/ui/dialog'");
  });

  test('toasts come from the named helpers, not @/lib/toast', () => {
    expect(imports).not.toContain("from '@/lib/toast'");
    expect(panelSource).toContain("from '@/components/ui/toast'");
    expect(panelSource).toContain('successToast(');
    expect(panelSource).toContain('errorToast(');
  });

  test('semantic colour is kortix-*, never a raw Tailwind palette or a dark: hack', () => {
    expect(panelSource).toContain('text-kortix-orange');
    expect(panelSource).toContain('text-kortix-red');
    expect(panelSource).not.toContain('amber-');
    expect(panelSource).not.toContain('dark:text-');
  });

  test('panels are rounded-md — never the rounded-2xl the old cards used', () => {
    expect(panelSource).not.toContain('rounded-2xl');
    expect(panelSource).not.toContain('rounded-xl');
  });

  // The trigger used to render label + description ("Ask first · Pause for human
  // approval"), which forced `min-w-[16rem] shrink-0` and squeezed the tool
  // pattern input beside it. `SelectItem description` renders in the menu only.
  test('the action select keeps its descriptions out of the closed trigger', () => {
    // Comments are stripped first — the prose above ACTION_META names the old
    // `min-w-[16rem]` on purpose, and must not satisfy the guard.
    const code = panelSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
    expect(code).toContain('description={ACTION_META[a].description}');
    expect(code).not.toContain('min-w-[16rem]');
  });
});

/**
 * Argument conditions must survive a panel round-trip.
 *
 * This panel replaces the WHOLE policy list on save, so any field the draft
 * fails to carry is a field the save silently DELETES. Before conditions were
 * threaded through `seedDraft` + `toPayloadRule`, merely opening the panel and
 * saving an unrelated edit would strip a recipient allow-list off a rule —
 * turning "only these addresses" into "any address" with no warning.
 */
describe('argument conditions survive the draft round-trip', () => {
  const RULE = {
    match: 'gmail.send_email',
    action: 'require_approval' as const,
    conditions: [{ arg: 'to', match: '/^owner@example\\.com$/' }],
  };

  test('seedDraft carries conditions onto the draft, with a stable row id', () => {
    const { draft } = seedDraft({ policies: [RULE], defaultMode: 'risk' });

    expect(draft[0]?.conditions).toMatchObject([{ arg: 'to', match: '/^owner@example\\.com$/' }]);
    // Keyed by a stable id, not the array index: deleting a middle condition
    // must not make React re-use the removed row's DOM node.
    expect(draft[0]?.conditions[0]?.id).toBeString();
  });

  test('seedDraft defaults a rule without conditions to an empty list, not undefined', () => {
    const { draft } = seedDraft({
      policies: [{ match: '*', action: 'block' }],
      defaultMode: 'risk',
    });

    expect(draft[0]?.conditions).toEqual([]);
  });

  test('a save re-emits the conditions it was seeded with', () => {
    const { draft } = seedDraft({ policies: [RULE], defaultMode: 'risk' });

    expect(toPayloadRule(draft[0]!)).toEqual(RULE);
  });

  test('an unconditional rule omits the key entirely rather than sending []', () => {
    const { draft } = seedDraft({
      policies: [{ match: '*', action: 'block' }],
      defaultMode: 'risk',
    });

    const payload = toPayloadRule(draft[0]!);
    expect(payload).toEqual({ match: '*', action: 'block' });
    expect('conditions' in payload).toBe(false);
  });

  test('half-typed condition rows are dropped so they cannot fail the whole save', () => {
    const payload = toPayloadRule({
      id: 'r1',
      match: 'gmail.send_email',
      action: 'block',
      conditions: [
        { id: 'c1', arg: 'to', match: '' },
        { id: 'c2', arg: '', match: 'x' },
        { id: 'c3', arg: '  bcc  ', match: '  *@example.com  ' },
      ],
    });

    expect(payload.conditions).toEqual([{ arg: 'bcc', match: '*@example.com' }]);
  });

  test('negate is preserved when set and omitted when not', () => {
    const withNegate = toPayloadRule({
      id: 'r1',
      match: 'gmail.send_email',
      action: 'block',
      conditions: [{ id: 'c1', arg: 'to', match: '*', negate: true }],
    });
    const withoutNegate = toPayloadRule({
      id: 'r2',
      match: 'gmail.send_email',
      action: 'block',
      conditions: [{ id: 'c1', arg: 'to', match: '*', negate: false }],
    });

    expect(withNegate.conditions).toEqual([{ arg: 'to', match: '*', negate: true }]);
    expect(withoutNegate.conditions).toEqual([{ arg: 'to', match: '*' }]);
  });
});
