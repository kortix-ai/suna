import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  KORTIX_CLI_CATALOG,
  PERMISSION_ACTION_ONLY_KEYS,
  PERMISSION_KEY_HELP,
  PERMISSION_RULE_GROUPS,
  PERMISSION_RULE_KEYS,
  Segmented,
  grantSummary,
} from './agent-editor';

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

describe('Segmented control', () => {
  test('renders every option and marks the active one', () => {
    const html = renderToStaticMarkup(
      <Segmented
        options={[
          { value: 'primary', label: 'primary' },
          { value: 'subagent', label: 'subagent' },
          { value: 'all', label: 'all' },
        ]}
        value="subagent"
        onChange={() => {}}
      />,
    );
    expect(html).toContain('primary');
    expect(html).toContain('subagent');
    expect(html).toContain('all');
    // The active option carries the selected styling token; the others don't.
    expect(html).toContain('bg-secondary');
  });

  test('an unset value renders with no active styling', () => {
    const html = renderToStaticMarkup(
      <Segmented
        options={[
          { value: 'allow', label: 'Allow' },
          { value: 'deny', label: 'Deny' },
        ]}
        value={undefined}
        onChange={() => {}}
      />,
    );
    expect(html).not.toContain('bg-secondary');
  });
});

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

  test('covers the core grantable leaves the editor must offer', () => {
    for (const expected of [
      'project.session.start',
      'project.cr.open',
      'project.cr.merge',
      'project.deploy',
      'project.secret.write',
      'project.connector.write',
      'project.review.act',
    ]) {
      expect(all).toContain(expected);
    }
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
