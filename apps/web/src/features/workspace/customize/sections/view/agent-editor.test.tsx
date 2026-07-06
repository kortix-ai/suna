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

// The canonical grantable `kortix_cli` catalog — MUST be kept byte-for-byte in
// sync with `GRANTABLE_KORTIX_CLI_ACTIONS` in packages/manifest-schema/src/constants.ts
// and `GRANTABLE_KORTIX_CLI` in apps/api/src/projects/agents.ts (Object.values(
// PROJECT_ACTIONS)). Hardcoded here rather than imported (the manifest-schema/
// api packages aren't in the web bundle, same mirror discipline as
// KORTIX_CLI_CATALOG itself) — a full-array equality check, not a partial
// spot-check, so an entry silently added or removed on either side of the
// mirror fails this test immediately instead of only showing up as a UI gap
// someone notices later.
const CANONICAL_GRANTABLE_KORTIX_CLI_ACTIONS = [
  'project.read',
  'project.write',
  'project.deploy',
  'project.delete',
  'project.cr.open',
  'project.cr.merge',
  'project.session.read',
  'project.session.start',
  'project.session.stop',
  'project.members.read',
  'project.members.manage',
  'project.trigger.read',
  'project.trigger.create',
  'project.trigger.update',
  'project.trigger.delete',
  'project.trigger.fire',
  'project.gateway.logs.read',
  'project.gateway.spend.read',
  'project.gateway.budget.set',
  'project.gateway.keys.manage',
  'project.agent.read',
  'project.agent.write',
  'project.skill.read',
  'project.skill.write',
  'project.command.read',
  'project.command.write',
  'project.file.read',
  'project.file.write',
  'project.customize.read',
  'project.customize.write',
  'project.gitops.read',
  'project.gitops.push',
  'project.gitops.merge',
  'project.secret.read',
  'project.secret.write',
  'project.connector.read',
  'project.connector.write',
  'project.review.read',
  'project.review.submit',
  'project.review.act',
].sort();

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

  test('full-array equality against the canonical grantable catalog (40 actions)', () => {
    expect(all.length).toBe(CANONICAL_GRANTABLE_KORTIX_CLI_ACTIONS.length);
    expect([...all].sort()).toEqual(CANONICAL_GRANTABLE_KORTIX_CLI_ACTIONS);
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
