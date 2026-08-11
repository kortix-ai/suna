import { GRANTABLE_KORTIX_CLI_ACTIONS } from '@kortix/manifest-schema';
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  AGENT_MODE_LABEL,
  AGENT_MODES,
  grantSummary,
  KORTIX_CLI_CATALOG,
  PERMISSION_ACTION_LABEL,
  PERMISSION_ACTION_ONLY_KEYS,
  PERMISSION_ACTIONS,
  PERMISSION_KEY_HELP,
  PERMISSION_KEY_LABEL,
  PERMISSION_RULE_GROUPS,
  PERMISSION_RULE_KEYS,
  stableStringify,
  THEME_COLOR_SWATCH,
  THEME_COLORS,
  WORKSPACE_MODE_LABEL,
  WORKSPACE_MODES,
} from './agent-editor';

const read = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');
const editorSource = read('./agent-editor.tsx');
const accessFieldsSource = read('./agent-editor-access-fields.tsx');
const basicsFieldsSource = read('./agent-editor-basics-fields.tsx');
const primitivesSource = read('./agent-editor-primitives.tsx');
const grantFieldSource = read('./grant-mode-field.tsx');
const permissionEditorSource = read('./permission-editor.tsx');
const sectionSources = [accessFieldsSource, basicsFieldsSource, permissionEditorSource];
const allEditorSources = [...sectionSources, editorSource, primitivesSource, grantFieldSource];

describe('agent environment editor', () => {
  test('loads sandbox templates and exposes the Environment field', () => {
    expect(editorSource).toContain('listProjectSandboxTemplates(projectId)');
    expect(editorSource).toContain('options.set(initial.sandbox, initial.sandbox)');
    expect(accessFieldsSource).toContain('label="Environment"');
    expect(accessFieldsSource).toContain("set('sandbox'");
    expect(accessFieldsSource).toContain('Project default');
  });
});

// The editor is grouped by the QUESTION each field answers, not by the file the
// value lands in. The two storage-named headings ("dosco" / "OpenCode") and
// the icons that decorated them are gone; these guards fail if either comes
// back.
describe('section structure — questions, not storage layers', () => {
  test('every section the shell composes is rendered exactly once', () => {
    for (const section of [
      'BasicsSection',
      'ModelSection',
      'AccessSection',
      'WorkspaceSection',
      'ToolsSection',
    ]) {
      expect(editorSource).toContain(`<${section}`);
    }
  });

  test('no layer heading, and no icon chrome, survives in the editor', () => {
    for (const source of allEditorSources) {
      expect(source).not.toContain('LayerHeader');
      expect(source).not.toContain('tone="kortix"');
      expect(source).not.toContain('label="OpenCode"');
    }
    // The primitives import no icon library at all — that is what stops an
    // icon slot growing back onto the section header.
    expect(primitivesSource).not.toContain('@phosphor-icons/react');
  });

  test('the primitives module exports the three layout shapes', () => {
    for (const primitive of ['EditorSection', 'SettingRow', 'SettingBlock']) {
      expect(primitivesSource).toContain(`export function ${primitive}`);
    }
  });
});

// Below `text-xs` the editor was unreadable — `text-[11px]` help lines,
// `text-[10px]` group headings, a `text-[9px]` checkmark. `text-xs` is the
// floor now and there is no arbitrary-value font size anywhere in the editor.
describe('typography floor', () => {
  test('no arbitrary pixel font size in any editor source', () => {
    for (const source of allEditorSources) {
      expect(source).not.toMatch(/text-\[\d+px\]/);
    }
  });
});

describe('stableStringify — the dirty check', () => {
  test('key order does not change the result', () => {
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }));
  });

  // The bug this fixes: `set` deletes a key to clear it, so re-setting the same
  // value re-adds it at the END of the object. Plain JSON.stringify then
  // reported the draft as dirty against an identical baseline.
  test('a cleared-then-restored field is not dirty', () => {
    const baseline = { enabled: false, sandbox: 'gpu', skills: 'all' };
    const cleared: Record<string, unknown> = { ...baseline };
    delete cleared.sandbox;
    const restored = { ...cleared, sandbox: 'gpu' };
    expect(JSON.stringify(restored)).not.toBe(JSON.stringify(baseline)); // the old check
    expect(stableStringify(restored)).toBe(stableStringify(baseline)); // the new one
  });

  test('nested objects and arrays are compared by content', () => {
    expect(stableStringify({ opencode: { mode: 'all', color: 'info' } })).toBe(
      stableStringify({ opencode: { color: 'info', mode: 'all' } }),
    );
    expect(stableStringify({ skills: ['a', 'b'] })).not.toBe(
      stableStringify({ skills: ['b', 'a'] }),
    );
  });

  test('an undefined value reads the same as an absent key', () => {
    expect(stableStringify({ a: 1, b: undefined })).toBe(stableStringify({ a: 1 }));
  });
});

describe('grantSummary — governance grant card labels', () => {
  test('"all" → All / outline', () => {
    expect(grantSummary('all')).toEqual({ label: 'All', tone: 'outline' });
  });
  test('undefined (omitted, deny-by-default) → None / muted', () => {
    expect(grantSummary(undefined)).toEqual({ label: 'None', tone: 'muted' });
  });
  test('"none" → None / muted', () => {
    expect(grantSummary('none')).toEqual({ label: 'None', tone: 'muted' });
  });
  test('empty list → None / muted (picked nothing reads as deny, not all)', () => {
    expect(grantSummary([])).toEqual({ label: 'None', tone: 'muted' });
  });
  test('a specific list → "<n> picked" / outline', () => {
    expect(grantSummary(['a', 'b', 'c'])).toEqual({ label: '3 picked', tone: 'outline' });
  });
});

// The local `Segmented` / `FieldRow` primitives are gone. Every mode picker is
// now a real @/components/ui component: Tabs for the grant mode (a required
// three-way choice), Select everywhere the choice includes an inherit state.
// These guards fail if either primitive creeps back in.
describe('mode pickers use the shared component library', () => {
  test('the primitives module holds layout only — no Segmented, no FieldRow', () => {
    expect(primitivesSource).not.toContain('Segmented');
    expect(primitivesSource).not.toContain('FieldRow');
  });

  test('the grant-mode field is built from Tabs', () => {
    expect(grantFieldSource).toContain("from '@/components/ui/tabs'");
    expect(grantFieldSource).toContain('TabsTriggerCompact');
    for (const mode of ['all', 'pick', 'none']) {
      expect(grantFieldSource).toContain(`value: '${mode}'`);
    }
  });

  test('Tabs stay scoped to the grant-mode field — every section uses Select', () => {
    for (const source of sectionSources) {
      expect(source).not.toContain('@/components/ui/tabs');
      expect(source).toContain("from '@/components/ui/select'");
    }
  });

  // The control these replaced hid "unset" behind clicking the already-active
  // segment. Every inherit-capable picker must now NAME that option.
  test('every inherit-capable picker names its inherit option', () => {
    expect(accessFieldsSource).toContain('Project default');
    expect(basicsFieldsSource).toContain('Project default');
    expect(permissionEditorSource).toContain('inheritLabel');
    expect(permissionEditorSource).toContain('inheritLabel="Inherit"');
  });
});

describe('display-name maps — Select renders the value verbatim', () => {
  test('every mode and action has a non-empty capitalized label', () => {
    const cases: [readonly string[], Record<string, string>][] = [
      [AGENT_MODES, AGENT_MODE_LABEL],
      [WORKSPACE_MODES, WORKSPACE_MODE_LABEL],
      [PERMISSION_ACTIONS, PERMISSION_ACTION_LABEL],
    ];
    for (const [values, labels] of cases) {
      for (const value of values) {
        const label = labels[value];
        expect(label).toBeString();
        expect(label!.length).toBeGreaterThan(0);
        expect(label![0]).toBe(value[0]!.toUpperCase());
      }
    }
  });
});

// KORTIX_CLI_CATALOG (the picker's grouped catalog) MUST expose exactly the
// actions `GRANTABLE_KORTIX_CLI_ACTIONS` allows — imported from the real
// @kortix/manifest-schema package (not a hand-copied array) so an action
// silently added or removed on either side of the mirror fails this test
// immediately instead of only showing up as a UI gap someone notices later.
// bun:test files aren't bundled for the browser, so importing the package
// here carries none of the "not in the web bundle" bundle-size concern that
// keeps KORTIX_CLI_CATALOG itself hand-authored — apps/api's
// unit-agents-parse.test.ts does the same cross-package import.
describe('KORTIX_CLI_CATALOG — grantable action mirror', () => {
  const all = KORTIX_CLI_CATALOG.flatMap((g) => g.actions);

  test('only project-scoped actions appear (account-scoped admin never grantable)', () => {
    for (const a of all) {
      expect(a.startsWith('project.')).toBe(true);
    }
    expect(all).not.toContain('billing.read');
    expect(all).not.toContain('member.invite');
    expect(all).not.toContain('project.create');
  });

  // The three manager-tier project leaves are grantable again — reachable via
  // a project's `manager` role, so an agent can carry them too.
  test('the three manager-tier project leaves are present', () => {
    expect(all).toContain('project.delete');
    expect(all).toContain('project.members.manage');
    expect(all).toContain('project.gateway.keys.manage');
  });

  test('full-array equality against the real GRANTABLE_KORTIX_CLI_ACTIONS (order-independent)', () => {
    expect(all.length).toBe(GRANTABLE_KORTIX_CLI_ACTIONS.length);
    expect([...all].sort()).toEqual([...GRANTABLE_KORTIX_CLI_ACTIONS].sort());
  });

  test('has no duplicate actions across groups', () => {
    expect(new Set(all).size).toBe(all.length);
  });
});

describe('PERMISSION_RULE_GROUPS — permission-tree grouping', () => {
  test('every PERMISSION_RULE_KEYS entry appears in exactly one group', () => {
    const grouped = PERMISSION_RULE_GROUPS.flatMap((g) => g.keys);
    expect(new Set(grouped)).toEqual(new Set(PERMISSION_RULE_KEYS));
    expect(new Set(grouped).size).toBe(grouped.length);
  });

  test('groups are non-empty and labeled', () => {
    for (const group of PERMISSION_RULE_GROUPS) {
      expect(group.label.length).toBeGreaterThan(0);
      expect(group.keys.length).toBeGreaterThan(0);
    }
  });
});

describe('PERMISSION_KEY_HELP — inline help coverage', () => {
  test('every rule key and action-only key has a non-empty help string', () => {
    for (const key of [...PERMISSION_RULE_KEYS, ...PERMISSION_ACTION_ONLY_KEYS]) {
      expect(typeof PERMISSION_KEY_HELP[key]).toBe('string');
      expect(PERMISSION_KEY_HELP[key]?.length).toBeGreaterThan(0);
    }
  });
});

// A row reading only `external_directory` or `lsp` told a reader nothing. Every
// permission key now leads with a sentence and keeps the manifest token beside
// it; a key added without a label would silently fall back to the raw token.
describe('PERMISSION_KEY_LABEL — plain-word names', () => {
  test('every key has a label that is not just the raw token', () => {
    for (const key of [...PERMISSION_RULE_KEYS, ...PERMISSION_ACTION_ONLY_KEYS]) {
      const label = PERMISSION_KEY_LABEL[key];
      expect(typeof label).toBe('string');
      expect(label?.length).toBeGreaterThan(0);
      expect(label).not.toBe(key);
      expect(label).not.toContain('_');
    }
  });

  test('the editor renders the label, not only the key', () => {
    expect(permissionEditorSource).toContain('PERMISSION_KEY_LABEL[permKey]');
  });
});

describe('THEME_COLOR_SWATCH — the colour picker shows colour', () => {
  test('every theme colour maps to a token class', () => {
    for (const color of THEME_COLORS) {
      const swatch = THEME_COLOR_SWATCH[color];
      expect(swatch.startsWith('bg-')).toBe(true);
      // Brand + semantic tokens only. A raw palette class here would be the
      // one place in the editor that hardcodes a colour.
      expect(swatch).toMatch(/^bg-(kortix-[a-z]+|foreground|muted-foreground)$/);
    }
  });
});
