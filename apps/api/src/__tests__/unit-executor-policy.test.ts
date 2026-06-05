/**
 * Tool-call policy engine — glob match, first-match-wins, single-scope action
 * resolution, layered (project → connector → risk-default) resolution, and
 * visibility (blocked tools hidden). Mirrors executor's model.
 */
import { describe, expect, test } from 'bun:test';
import {
  globToRegex,
  isRegexMatcher,
  isValidMatcher,
  isVisible,
  isVisibleEffective,
  matchesPolicy,
  resolveEffectiveAction,
  resolvePolicyAction,
  riskDefaultAction,
  type Policy,
} from '../executor/policy';

describe('matchesPolicy', () => {
  test('* matches everything', () => {
    expect(matchesPolicy('*', 'charges.create')).toBe(true);
  });
  test('exact', () => {
    expect(matchesPolicy('charges.create', 'charges.create')).toBe(true);
    expect(matchesPolicy('charges.create', 'charges.list')).toBe(false);
  });
  test('trailing wildcard', () => {
    expect(matchesPolicy('charges.*', 'charges.create')).toBe(true);
    expect(matchesPolicy('charges.*', 'refunds.create')).toBe(false);
  });
  test('mid/leading wildcard (e.g. *.delete*)', () => {
    expect(matchesPolicy('*.delete*', 'pets.deletePet')).toBe(true);
    expect(matchesPolicy('*.delete*', 'pets.getPet')).toBe(false);
  });
  test('case-insensitive', () => {
    expect(matchesPolicy('Charges.*', 'charges.create')).toBe(true);
  });
  test('globToRegex anchors', () => {
    expect(globToRegex('a.b').test('xa.by')).toBe(false);
  });
  test('regex matcher /.../ — not auto-anchored, case-insensitive by default', () => {
    expect(matchesPolicy('/^delete_/', 'delete_message')).toBe(true);
    expect(matchesPolicy('/^delete_/', 'send_message')).toBe(false);
    expect(matchesPolicy('/(create|update)/', 'charges.update')).toBe(true);   // unanchored
    expect(matchesPolicy('/SEND/', 'send_email')).toBe(true);                  // default i flag
  });
  test('invalid regex never matches (fail-safe, never allow-all)', () => {
    expect(matchesPolicy('/(/', 'anything')).toBe(false);
  });
  test('isRegexMatcher / isValidMatcher', () => {
    expect(isRegexMatcher('/^x$/')).toBe(true);
    expect(isRegexMatcher('send_*')).toBe(false);
    expect(isValidMatcher('/(/')).toBe(false);
    expect(isValidMatcher('/^ok$/')).toBe(true);
    expect(isValidMatcher('send_*')).toBe(true);
  });
});

describe('resolvePolicyAction — first match wins, position order', () => {
  const policies: Policy[] = [
    { match: '*.delete*', action: 'block', position: 0 },
    { match: 'charges.create', action: 'require_approval', position: 1 },
    { match: '*', action: 'always_run', position: 2 },
  ];

  test('block wins for delete', () => {
    expect(resolvePolicyAction('pets.deletePet', policies)).toBe('block');
  });
  test('require_approval for the specific create', () => {
    expect(resolvePolicyAction('charges.create', policies)).toBe('require_approval');
  });
  test('catch-all always_run otherwise', () => {
    expect(resolvePolicyAction('charges.list', policies)).toBe('always_run');
  });
  test('no policies → always_run (allow-all default)', () => {
    expect(resolvePolicyAction('anything', [])).toBe('always_run');
  });
  test('position controls precedence regardless of array order', () => {
    const reordered: Policy[] = [
      { match: '*', action: 'always_run', position: 5 },
      { match: 'secret.*', action: 'block', position: 0 },
    ];
    expect(resolvePolicyAction('secret.read', reordered)).toBe('block');
  });
});

describe('isVisible', () => {
  test('blocked tools are hidden', () => {
    const policies: Policy[] = [{ match: 'admin.*', action: 'block' }];
    expect(isVisible('admin.reset', policies)).toBe(false);
    expect(isVisible('users.list', policies)).toBe(true);
  });
});

describe('riskDefaultAction', () => {
  test('read → always_run, write/destructive → require_approval', () => {
    expect(riskDefaultAction('read')).toBe('always_run');
    expect(riskDefaultAction('write')).toBe('require_approval');
    expect(riskDefaultAction('destructive')).toBe('require_approval');
  });
});

describe('resolveEffectiveAction — layered (project → connector → default)', () => {
  const projectPolicies: Policy[] = [
    { match: '*.delete*', action: 'block', position: 0 },
    { match: 'stripe.*', action: 'require_approval', position: 1 },
  ];
  const connectorPolicies: Policy[] = [
    { match: 'charges.create', action: 'always_run', position: 0 },
    { match: '*', action: 'block', position: 1 },
  ];

  test('project block wins over connector always_run (admin trust)', () => {
    // pets.deletePet hits project `*.delete*` block FIRST — connector rules
    // cannot override.
    expect(
      resolveEffectiveAction({
        fullPath: 'pets.deletePet',
        relPath: 'deletePet',
        projectPolicies,
        connectorPolicies,
        risk: 'destructive',
        defaultMode: 'risk',
      }),
    ).toEqual({ action: 'block', source: 'project' });
  });

  test('project require_approval wins over connector always_run', () => {
    // stripe.charges.create — project rule says require_approval, even though
    // connector rule says always_run. Project wins.
    expect(
      resolveEffectiveAction({
        fullPath: 'stripe.charges.create',
        relPath: 'charges.create',
        projectPolicies,
        connectorPolicies,
        risk: 'write',
        defaultMode: 'risk',
      }),
    ).toEqual({ action: 'require_approval', source: 'project' });
  });

  test('falls through to connector when project has no match', () => {
    // pets.list — no project rule matches → connector `*` catch-all = block.
    expect(
      resolveEffectiveAction({
        fullPath: 'pets.list',
        relPath: 'list',
        projectPolicies,
        connectorPolicies,
        risk: 'read',
        defaultMode: 'risk',
      }),
    ).toEqual({ action: 'block', source: 'connector' });
  });

  test('default_mode=risk: write → require_approval, read → always_run', () => {
    expect(
      resolveEffectiveAction({
        fullPath: 'gmail.send',
        relPath: 'send',
        projectPolicies: [],
        connectorPolicies: [],
        risk: 'write',
        defaultMode: 'risk',
      }),
    ).toEqual({ action: 'require_approval', source: 'risk_default' });
    expect(
      resolveEffectiveAction({
        fullPath: 'gmail.read',
        relPath: 'read',
        projectPolicies: [],
        connectorPolicies: [],
        risk: 'read',
        defaultMode: 'risk',
      }),
    ).toEqual({ action: 'always_run', source: 'risk_default' });
  });

  test('default_mode=allow_all: every unmatched call runs', () => {
    expect(
      resolveEffectiveAction({
        fullPath: 'stripe.charges.create',
        relPath: 'charges.create',
        projectPolicies: [],
        connectorPolicies: [],
        risk: 'destructive',
        defaultMode: 'allow_all',
      }),
    ).toEqual({ action: 'always_run', source: 'allow_all' });
  });

  test('project full-qualified match vs connector relative — patterns are different scopes', () => {
    // Project pattern is `vercel.dns.*` — only fires for vercel.dns.* paths.
    const project: Policy[] = [{ match: 'vercel.dns.*', action: 'block', position: 0 }];
    const conn: Policy[] = []; // no connector rules

    // vercel.dns.create → project blocks.
    expect(
      resolveEffectiveAction({
        fullPath: 'vercel.dns.create',
        relPath: 'dns.create',
        projectPolicies: project,
        connectorPolicies: conn,
        risk: 'write',
        defaultMode: 'risk',
      }).action,
    ).toBe('block');
    // vercel.projects.list → project doesn't match → risk-default for read = always_run.
    expect(
      resolveEffectiveAction({
        fullPath: 'vercel.projects.list',
        relPath: 'projects.list',
        projectPolicies: project,
        connectorPolicies: conn,
        risk: 'read',
        defaultMode: 'risk',
      }),
    ).toEqual({ action: 'always_run', source: 'risk_default' });
  });
});

describe('isVisibleEffective — blocked-from-search across layers', () => {
  test('project block hides the tool from search', () => {
    expect(
      isVisibleEffective({
        fullPath: 'pets.deletePet',
        relPath: 'deletePet',
        projectPolicies: [{ match: '*.delete*', action: 'block', position: 0 }],
        connectorPolicies: [],
        risk: 'destructive',
        defaultMode: 'risk',
      }),
    ).toBe(false);
  });
  test('connector require_approval is still visible', () => {
    expect(
      isVisibleEffective({
        fullPath: 'pets.create',
        relPath: 'create',
        projectPolicies: [],
        connectorPolicies: [{ match: '*', action: 'require_approval' }],
        risk: 'write',
        defaultMode: 'risk',
      }),
    ).toBe(true);
  });
});
