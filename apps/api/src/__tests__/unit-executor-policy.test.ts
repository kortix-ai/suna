/**
 * Tool-call policy engine — glob match, first-match-wins, layered
 * (project → connector → risk-default) resolution.
 * Mirrors executor's model.
 */
import { describe, expect, test } from 'bun:test';
import {
  resolveEffectiveAction,
  type Policy,
} from '../executor/policy';

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

  test('policy glob matching supports catch-all, exact, wildcards, case-insensitivity, and anchoring', () => {
    expect(
      resolveEffectiveAction({
        fullPath: 'charges.create',
        relPath: 'charges.create',
        projectPolicies: [{ match: '*', action: 'block', position: 0 }],
        connectorPolicies: [],
        risk: 'read',
        defaultMode: 'risk',
      }),
    ).toEqual({ action: 'block', source: 'project' });

    expect(
      resolveEffectiveAction({
        fullPath: 'charges.create',
        relPath: 'charges.create',
        projectPolicies: [{ match: 'charges.create', action: 'block', position: 0 }],
        connectorPolicies: [],
        risk: 'read',
        defaultMode: 'risk',
      }),
    ).toEqual({ action: 'block', source: 'project' });

    expect(
      resolveEffectiveAction({
        fullPath: 'charges.list',
        relPath: 'charges.list',
        projectPolicies: [{ match: 'charges.create', action: 'block', position: 0 }],
        connectorPolicies: [],
        risk: 'read',
        defaultMode: 'risk',
      }),
    ).toEqual({ action: 'always_run', source: 'risk_default' });

    expect(
      resolveEffectiveAction({
        fullPath: 'charges.create',
        relPath: 'charges.create',
        projectPolicies: [{ match: 'Charges.*', action: 'block', position: 0 }],
        connectorPolicies: [],
        risk: 'read',
        defaultMode: 'risk',
      }),
    ).toEqual({ action: 'block', source: 'project' });

    expect(
      resolveEffectiveAction({
        fullPath: 'pets.deletePet',
        relPath: 'pets.deletePet',
        projectPolicies: [{ match: '*.delete*', action: 'block', position: 0 }],
        connectorPolicies: [],
        risk: 'read',
        defaultMode: 'risk',
      }),
    ).toEqual({ action: 'block', source: 'project' });

    expect(
      resolveEffectiveAction({
        fullPath: 'xa.by',
        relPath: 'xa.by',
        projectPolicies: [{ match: 'a.b', action: 'block', position: 0 }],
        connectorPolicies: [],
        risk: 'read',
        defaultMode: 'risk',
      }),
    ).toEqual({ action: 'always_run', source: 'risk_default' });
  });
});
