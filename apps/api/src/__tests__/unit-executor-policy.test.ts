/**
 * Tool-call policy engine — glob match, first-match-wins, single-scope action
 * resolution, layered (project → connector → risk-default) resolution, and
 * visibility (blocked tools hidden). Mirrors executor's model.
 */
import { describe, expect, test } from 'bun:test';
import {
  isValidMatcher,
  resolveEffectiveAction,
  type Policy,
} from '../executor/policy';

function resolveWithConnector(path: string, policies: Policy[]) {
  return resolveEffectiveAction({
    fullPath: `connector.${path}`,
    relPath: path,
    projectPolicies: [],
    connectorPolicies: policies,
    risk: 'write',
    defaultMode: 'risk',
  });
}

describe('matcher semantics', () => {
  test('* matches everything', () => {
    expect(resolveWithConnector('charges.create', [{ match: '*', action: 'block' }])).toEqual({ action: 'block', source: 'connector' });
  });
  test('exact', () => {
    expect(resolveWithConnector('charges.create', [{ match: 'charges.create', action: 'block' }])).toEqual({ action: 'block', source: 'connector' });
    expect(resolveWithConnector('charges.list', [{ match: 'charges.create', action: 'block' }])).toEqual({ action: 'require_approval', source: 'risk_default' });
  });
  test('trailing wildcard', () => {
    expect(resolveWithConnector('charges.create', [{ match: 'charges.*', action: 'block' }])).toEqual({ action: 'block', source: 'connector' });
    expect(resolveWithConnector('refunds.create', [{ match: 'charges.*', action: 'block' }])).toEqual({ action: 'require_approval', source: 'risk_default' });
  });
  test('mid/leading wildcard (e.g. *.delete*)', () => {
    expect(resolveWithConnector('pets.deletePet', [{ match: '*.delete*', action: 'block' }])).toEqual({ action: 'block', source: 'connector' });
    expect(resolveWithConnector('pets.getPet', [{ match: '*.delete*', action: 'block' }])).toEqual({ action: 'require_approval', source: 'risk_default' });
  });
  test('case-insensitive', () => {
    expect(resolveWithConnector('charges.create', [{ match: 'Charges.*', action: 'block' }])).toEqual({ action: 'block', source: 'connector' });
  });
  test('glob matching is anchored', () => {
    expect(resolveWithConnector('xa.by', [{ match: 'a.b', action: 'block' }])).toEqual({ action: 'require_approval', source: 'risk_default' });
  });
  test('regex matcher /.../ — not auto-anchored, case-insensitive by default', () => {
    expect(resolveWithConnector('delete_message', [{ match: '/^delete_/', action: 'block' }])).toEqual({ action: 'block', source: 'connector' });
    expect(resolveWithConnector('send_message', [{ match: '/^delete_/', action: 'block' }])).toEqual({ action: 'require_approval', source: 'risk_default' });
    expect(resolveWithConnector('charges.update', [{ match: '/(create|update)/', action: 'block' }])).toEqual({ action: 'block', source: 'connector' }); // unanchored
    expect(resolveWithConnector('send_email', [{ match: '/SEND/', action: 'block' }])).toEqual({ action: 'block', source: 'connector' }); // default i flag
  });
  test('invalid regex never matches (fail-safe, never allow-all)', () => {
    expect(resolveWithConnector('anything', [{ match: '/(/', action: 'block' }])).toEqual({ action: 'require_approval', source: 'risk_default' });
  });
  test('validates matcher syntax', () => {
    expect(isValidMatcher('/(/')).toBe(false);
    expect(isValidMatcher('/^ok$/')).toBe(true);
    expect(isValidMatcher('send_*')).toBe(true);
  });
});

describe('policy position resolution', () => {
  const policies: Policy[] = [
    { match: '*.delete*', action: 'block', position: 0 },
    { match: 'charges.create', action: 'require_approval', position: 1 },
    { match: '*', action: 'always_run', position: 2 },
  ];

  test('block wins for delete', () => {
    expect(resolveWithConnector('pets.deletePet', policies)).toEqual({ action: 'block', source: 'connector' });
  });
  test('require_approval for the specific create', () => {
    expect(resolveWithConnector('charges.create', policies)).toEqual({ action: 'require_approval', source: 'connector' });
  });
  test('catch-all always_run otherwise', () => {
    expect(resolveWithConnector('charges.list', policies)).toEqual({ action: 'always_run', source: 'connector' });
  });
  test('no policies → allow_all default can still run', () => {
    expect(
      resolveEffectiveAction({
        fullPath: 'connector.anything',
        relPath: 'anything',
        projectPolicies: [],
        connectorPolicies: [],
        risk: 'write',
        defaultMode: 'allow_all',
      }),
    ).toEqual({ action: 'always_run', source: 'allow_all' });
  });
  test('position controls precedence regardless of array order', () => {
    const reordered: Policy[] = [
      { match: '*', action: 'always_run', position: 5 },
      { match: 'secret.*', action: 'block', position: 0 },
    ];
    expect(resolveWithConnector('secret.read', reordered)).toEqual({ action: 'block', source: 'connector' });
  });
});

describe('visibility', () => {
  test('blocked tools are hidden', () => {
    const policies: Policy[] = [{ match: 'admin.*', action: 'block' }];
    expect(resolveWithConnector('admin.reset', policies).action !== 'block').toBe(false);
    expect(resolveWithConnector('users.list', policies).action !== 'block').toBe(true);
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

describe('blocked-from-search behavior', () => {
  test('project block hides the tool from search', () => {
    expect(
      resolveEffectiveAction({
        fullPath: 'pets.deletePet',
        relPath: 'deletePet',
        projectPolicies: [{ match: '*.delete*', action: 'block', position: 0 }],
        connectorPolicies: [],
        risk: 'destructive',
        defaultMode: 'risk',
      }).action !== 'block',
    ).toBe(false);
  });
  test('connector require_approval is still visible', () => {
    expect(
      resolveEffectiveAction({
        fullPath: 'pets.create',
        relPath: 'create',
        projectPolicies: [],
        connectorPolicies: [{ match: '*', action: 'require_approval' }],
        risk: 'write',
        defaultMode: 'risk',
      }).action !== 'block',
    ).toBe(true);
  });
});
