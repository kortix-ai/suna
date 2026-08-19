import { describe, expect, test } from 'bun:test';

import {
  AREA_TABLES,
  applyBulk,
  applyCell,
  applyLeaf,
  expandFold,
  foldSelection,
  unmappedLeaves,
} from './role-capability-matrix';
import type { CapabilityScope } from './role-capability-matrix';

/**
 * The matrix is a DISPLAY over the same leaf strings the IAM engine reads, so
 * the only thing that can break a role is the fold dropping a leaf. Everything
 * here is a leaf-set assertion.
 *
 * PROJECT_LEAVES / ACCOUNT_LEAVES mirror `apps/api/src/iam/actions.ts` (what
 * `GET /accounts/:id/iam/actions` returns, split by `resource_type`). They are
 * duplicated rather than imported because apps/web cannot import apps/api; the
 * count assertions below are the drift alarm — add a leaf to the API and this
 * test tells you to place it (or to accept it as Advanced-only).
 */
const PROJECT_LEAVES = [
  'project.read',
  'project.write',
  'project.delete',
  'project.cr.open',
  'project.cr.merge',
  'project.session.read',
  'project.session.start',
  'project.session.stop',
  'project.session.bindings.write',
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
  'project.connector.connections.manage',
  'project.connector.write',
  'project.app.read',
  'project.app.write',
  'project.app.deploy',
  'project.review.read',
  'project.review.submit',
  'project.review.act',
];

const ACCOUNT_LEAVES = [
  'account.read',
  'account.write',
  'account.delete',
  'billing.read',
  'billing.write',
  'audit.read',
  'member.read',
  'member.invite',
  'member.update',
  'member.remove',
  'member.super_admin.grant',
  'group.read',
  'group.create',
  'group.update',
  'group.delete',
  'group.members.manage',
  'policy.read',
  'policy.create',
  'policy.delete',
  'role.read',
  'role.create',
  'role.update',
  'role.delete',
  'token.read',
  'token.create',
  'token.revoke',
  'project.create',
];

function catalog() {
  return [
    ...PROJECT_LEAVES.map((action) => ({
      action,
      label: action,
      resource_type: 'project' as const,
    })),
    ...ACCOUNT_LEAVES.map((action) => ({
      action,
      label: action,
      resource_type: 'account' as const,
    })),
  ];
}

const CATALOG = catalog();

/** The exact leaf sets `role-perms.ts` gives the built-in roles. These are
 *  what `GET /iam/roles/:id/permissions` returns for a `builtin:*` role, and
 *  what the dialog seeds the matrix with. */
const PROJECT_MEMBER_BASELINE = [
  'project.read',
  'project.session.read',
  'project.members.read',
  'project.trigger.read',
  'project.session.start',
  'project.session.stop',
  'project.gateway.logs.read',
  'project.gateway.spend.read',
  'project.command.read',
  'project.gitops.read',
  'project.app.read',
  'project.review.read',
  'project.review.submit',
];
const PROJECT_MEMBER = [...PROJECT_MEMBER_BASELINE, 'project.trigger.fire'];
const MANAGER_EXTRAS = [
  'project.write',
  'project.trigger.create',
  'project.trigger.update',
  'project.trigger.delete',
  'project.trigger.fire',
  'project.gateway.budget.set',
  'project.agent.write',
  'project.skill.write',
  'project.command.write',
  'project.file.write',
  'project.customize.write',
  'project.gitops.push',
  'project.gitops.merge',
  'project.secret.write',
  'project.connector.write',
  'project.app.write',
  'project.app.deploy',
  'project.file.read',
  'project.secret.read',
  'project.agent.read',
  'project.connector.read',
  'project.skill.read',
  'project.customize.read',
  'project.review.act',
];
const PROJECT_MANAGER = [
  ...PROJECT_MEMBER_BASELINE,
  ...MANAGER_EXTRAS,
  'project.delete',
  'project.members.manage',
  'project.gateway.keys.manage',
  'project.session.bindings.write',
  'project.connector.connections.manage',
];

const ACCOUNT_MEMBER = [
  'account.read',
  'billing.read',
  'member.read',
  'group.read',
  'token.read',
];
const ACCOUNT_ADMIN = [
  ...ACCOUNT_MEMBER,
  'account.write',
  'member.invite',
  'member.update',
  'member.remove',
  'group.create',
  'group.update',
  'group.delete',
  'group.members.manage',
  'token.create',
  'token.revoke',
  'audit.read',
  'role.read',
  'role.create',
  'role.update',
  'role.delete',
  'policy.read',
  'policy.create',
  'policy.delete',
  'project.create',
];
const ACCOUNT_OWNER = [
  ...ACCOUNT_ADMIN,
  'account.delete',
  'billing.write',
  'member.super_admin.grant',
];

const BUILTIN_SETS: { name: string; scope: CapabilityScope; actions: string[] }[] = [
  { name: 'manager', scope: 'project', actions: PROJECT_MANAGER },
  { name: 'user (member floor)', scope: 'project', actions: PROJECT_MEMBER },
  { name: 'owner', scope: 'account', actions: ACCOUNT_OWNER },
  { name: 'admin', scope: 'account', actions: ACCOUNT_ADMIN },
  { name: 'member', scope: 'account', actions: ACCOUNT_MEMBER },
];

function sorted(set: Iterable<string>): string[] {
  return [...set].sort();
}

// ─── The mapping itself ─────────────────────────────────────────────────────

describe('AREA_TABLES covers the catalog', () => {
  test('the catalog copy still matches the API (drift alarm)', () => {
    expect(PROJECT_LEAVES.length).toBe(44);
    expect(ACCOUNT_LEAVES.length).toBe(27);
    expect(new Set(PROJECT_LEAVES).size).toBe(PROJECT_LEAVES.length);
    expect(new Set(ACCOUNT_LEAVES).size).toBe(ACCOUNT_LEAVES.length);
  });

  test('every project leaf is placed in a cell — zero unmapped', () => {
    expect(unmappedLeaves('project', CATALOG)).toEqual([]);
  });

  test('the only unmapped account leaf is the super-admin grant (§7: Advanced only)', () => {
    expect(unmappedLeaves('account', CATALOG)).toEqual(['member.super_admin.grant']);
  });

  test('no leaf appears in two cells', () => {
    for (const scope of ['project', 'account'] as const) {
      const seen = new Set<string>();
      for (const area of AREA_TABLES[scope]) {
        for (const leaf of [...area.view, ...area.edit]) {
          expect(seen.has(leaf)).toBe(false);
          seen.add(leaf);
        }
      }
    }
  });

  test('every table leaf is a real action in the catalog', () => {
    for (const scope of ['project', 'account'] as const) {
      const known = new Set(
        CATALOG.filter((a) => a.resource_type === scope).map((a) => a.action),
      );
      for (const area of AREA_TABLES[scope]) {
        for (const leaf of [...area.view, ...area.edit]) {
          expect({ scope, leaf, known: known.has(leaf) }).toEqual({ scope, leaf, known: true });
        }
      }
    }
  });
});

// ─── Fold → expand round-trip ───────────────────────────────────────────────

describe('foldSelection → expandFold is lossless', () => {
  for (const builtin of BUILTIN_SETS) {
    test(`built-in ${builtin.name}`, () => {
      const selected = new Set(builtin.actions);
      const fold = foldSelection(builtin.scope, CATALOG, selected);
      expect(sorted(expandFold(fold))).toEqual(sorted(selected));
    });
  }

  test('an empty role round-trips to empty', () => {
    const fold = foldSelection('project', CATALOG, new Set());
    expect([...expandFold(fold)]).toEqual([]);
    expect(fold.selectedCount).toBe(0);
    expect(fold.totalCount).toBe(44);
  });

  test('a full project role round-trips', () => {
    const selected = new Set(PROJECT_LEAVES);
    const fold = foldSelection('project', CATALOG, selected);
    expect(sorted(expandFold(fold))).toEqual(sorted(selected));
    expect(fold.selectedCount).toBe(44);
    expect(fold.areas.every((a) => a.view.state !== 'partial' && a.edit.state !== 'partial')).toBe(
      true,
    );
  });

  test('a leaf the catalog no longer lists is still kept and shown in Advanced', () => {
    const selected = new Set(['project.read', 'project.legacy.thing']);
    const fold = foldSelection('project', CATALOG, selected);
    expect(fold.unmapped.some((l) => l.action === 'project.legacy.thing' && l.selected)).toBe(true);
    expect(sorted(expandFold(fold))).toEqual(sorted(selected));
  });

  test('an unmapped account grant forces Advanced open', () => {
    const fold = foldSelection('account', CATALOG, new Set(['member.super_admin.grant']));
    expect(fold.needsAdvanced).toBe(true);
    expect(sorted(expandFold(fold))).toEqual(['member.super_admin.grant']);
  });
});

// ─── Cell states ────────────────────────────────────────────────────────────

describe('cell state', () => {
  function cell(scope: CapabilityScope, selected: string[], areaKey: string) {
    const fold = foldSelection(scope, CATALOG, new Set(selected));
    const row = fold.areas.find((a) => a.area.key === areaKey)!;
    return { view: row.view.state, edit: row.edit.state, partial: row.partial };
  }

  test('the built-in manager is fully checked everywhere except change requests', () => {
    const fold = foldSelection('project', CATALOG, new Set(PROJECT_MANAGER));
    const partial = fold.areas.filter((a) => a.partial).map((a) => a.area.key);
    // role-perms.ts gives manager neither project.cr.open nor project.cr.merge,
    // so the one cell that holds them is a genuine subset — not a mapping bug.
    expect(partial).toEqual(['git']);
    expect(
      fold.areas
        .filter((a) => a.area.key !== 'git')
        .every((a) => a.view.state === 'on' && a.edit.state === 'on'),
    ).toBe(true);
    expect(fold.areas.find((a) => a.area.key === 'git')!.view.state).toBe('on');
  });

  test('the member floor role reads as partial where §7 splits a cell', () => {
    expect(cell('project', PROJECT_MEMBER, 'project')).toEqual({
      view: 'on',
      edit: 'off',
      partial: false,
    });
    // start + stop granted, bindings.write not.
    expect(cell('project', PROJECT_MEMBER, 'sessions').edit).toBe('partial');
    // only command.read out of six Customize reads.
    expect(cell('project', PROJECT_MEMBER, 'customize').view).toBe('partial');
    expect(cell('project', PROJECT_MEMBER, 'git')).toEqual({
      view: 'on',
      edit: 'partial',
      partial: true,
    });
    expect(foldSelection('project', CATALOG, new Set(PROJECT_MEMBER)).needsAdvanced).toBe(true);
  });

  test('an area with no leaves on one side reads as off, never partial', () => {
    expect(cell('account', ACCOUNT_ADMIN, 'audit')).toEqual({
      view: 'on',
      edit: 'off',
      partial: false,
    });
    expect(cell('account', ACCOUNT_ADMIN, 'projects')).toEqual({
      view: 'off',
      edit: 'on',
      partial: false,
    });
  });
});

// ─── applyCell: implications ────────────────────────────────────────────────

describe('applyCell — Edit implies View', () => {
  test('checking Edit checks View', () => {
    const next = applyCell('project', new Set(), 'files', 'edit', true);
    expect(sorted(next)).toEqual(['project.file.read', 'project.file.write']);
  });

  test('checking Edit on Customize pulls in all six reads', () => {
    const next = applyCell('project', new Set(), 'customize', 'edit', true);
    expect(next.has('project.customize.read')).toBe(true);
    expect(next.has('project.agent.read')).toBe(true);
    expect(next.has('project.secret.read')).toBe(true);
    expect(next.size).toBe(13);
  });

  test('unchecking View unchecks Edit', () => {
    const on = applyCell('project', new Set(), 'members', 'edit', true);
    expect(sorted(on)).toEqual(['project.members.manage', 'project.members.read']);
    const off = applyCell('project', on, 'members', 'view', false);
    expect([...off]).toEqual([]);
  });

  test('checking View alone does not grant Edit', () => {
    const next = applyCell('project', new Set(), 'files', 'view', true);
    expect([...next]).toEqual(['project.file.read']);
  });

  test('unchecking Edit leaves View in place', () => {
    const on = applyCell('project', new Set(), 'files', 'edit', true);
    const off = applyCell('project', on, 'files', 'edit', false);
    expect([...off]).toEqual(['project.file.read']);
  });

  test('account Members Edit implies Members View', () => {
    const next = applyCell('account', new Set(), 'members', 'edit', true);
    expect(next.has('member.read')).toBe(true);
    expect(next.has('member.invite')).toBe(true);
    expect(next.has('member.super_admin.grant')).toBe(false);
  });
});

describe('applyLeaf — delete implies write', () => {
  test('project.delete pulls in project.write and project.read', () => {
    const next = applyLeaf('project', new Set(), 'project.delete', true);
    expect(sorted(next)).toEqual(['project.delete', 'project.read', 'project.write']);
  });

  test('dropping project.write drops project.delete', () => {
    const on = applyLeaf('project', new Set(), 'project.delete', true);
    const off = applyLeaf('project', on, 'project.write', false);
    expect(sorted(off)).toEqual(['project.read']);
  });

  test('account.delete pulls in account.write and account.read', () => {
    const next = applyLeaf('account', new Set(), 'account.delete', true);
    expect(sorted(next)).toEqual(['account.delete', 'account.read', 'account.write']);
  });
});

describe('applyCell — a push rewrites Files, Customize and Triggers', () => {
  test('checking Git & Reviews Edit sets the file, customize and trigger write leaves', () => {
    const next = applyCell('project', new Set(), 'git', 'edit', true);
    for (const leaf of [
      'project.file.write',
      'project.customize.write',
      'project.agent.write',
      'project.skill.write',
      'project.connector.write',
      'project.connector.connections.manage',
      'project.command.write',
      'project.secret.write',
      'project.trigger.create',
      'project.trigger.update',
      'project.trigger.delete',
      'project.trigger.fire',
    ]) {
      expect({ leaf, granted: next.has(leaf) }).toEqual({ leaf, granted: true });
    }
    // …and the View side of every area it touched.
    expect(next.has('project.file.read')).toBe(true);
    expect(next.has('project.trigger.read')).toBe(true);
    expect(next.has('project.gitops.read')).toBe(true);
    expect(next.has('project.review.read')).toBe(true);
  });

  test('unchecking Files Edit clears gitops push/merge and cr.merge', () => {
    const on = applyCell('project', new Set(), 'git', 'edit', true);
    const off = applyCell('project', on, 'files', 'edit', false);
    expect(off.has('project.gitops.push')).toBe(false);
    expect(off.has('project.gitops.merge')).toBe(false);
    expect(off.has('project.cr.merge')).toBe(false);
    // Opening a CR, submitting and acting on reviews do not rewrite the repo.
    expect(off.has('project.cr.open')).toBe(true);
    expect(off.has('project.review.submit')).toBe(true);
    expect(off.has('project.review.act')).toBe(true);
    expect(off.has('project.file.write')).toBe(false);
    expect(off.has('project.file.read')).toBe(true);
  });

  test('unchecking Customize Edit clears the same three git leaves', () => {
    const on = applyCell('project', new Set(), 'git', 'edit', true);
    const off = applyCell('project', on, 'customize', 'edit', false);
    expect(off.has('project.gitops.push')).toBe(false);
    expect(off.has('project.gitops.merge')).toBe(false);
    expect(off.has('project.cr.merge')).toBe(false);
    expect(off.has('project.customize.read')).toBe(true);
  });

  test('the Git row carries the note that explains it', () => {
    const git = AREA_TABLES.project.find((a) => a.key === 'git')!;
    expect(git.note).toBe(
      'Push access also grants Files, Customize and Triggers edit — a push rewrites those.',
    );
  });
});

// ─── Header actions ─────────────────────────────────────────────────────────

describe('applyBulk', () => {
  test('View everything grants exactly the view leaves', () => {
    const next = applyBulk('project', new Set(), 'view-all', CATALOG);
    expect(next.has('project.read')).toBe(true);
    expect(next.has('project.customize.read')).toBe(true);
    expect(next.has('project.write')).toBe(false);
    const fold = foldSelection('project', CATALOG, next);
    expect(fold.areas.every((a) => a.view.state === 'on' && a.edit.state === 'off')).toBe(true);
  });

  test('Edit everything grants the whole project catalog', () => {
    const next = applyBulk('project', new Set(), 'edit-all', CATALOG);
    expect(sorted(next)).toEqual(sorted(PROJECT_LEAVES));
  });

  test('Edit everything on account scope leaves the Advanced-only grant alone', () => {
    const next = applyBulk('account', new Set(), 'edit-all', CATALOG);
    expect(next.has('member.super_admin.grant')).toBe(false);
    expect(next.size).toBe(ACCOUNT_LEAVES.length - 1);
  });

  test('Clear empties the scope, including unmapped grants', () => {
    const on = applyBulk('account', new Set(['member.super_admin.grant']), 'edit-all', CATALOG);
    expect([...applyBulk('account', on, 'clear', CATALOG)]).toEqual([]);
  });

  test('Clear never touches leaves from the other scope', () => {
    const mixed = new Set(['project.read', 'account.read']);
    expect([...applyBulk('project', mixed, 'clear', CATALOG)]).toEqual(['account.read']);
  });
});

// ─── Catalog-awareness ──────────────────────────────────────────────────────

describe('an incomplete catalog never invents a grant', () => {
  const trimmed = CATALOG.filter((a) => a.action !== 'project.file.write');

  test('a leaf missing from the catalog is not added by a cell toggle', () => {
    const available = new Set(trimmed.filter((a) => a.resource_type === 'project').map((a) => a.action));
    const next = applyCell('project', new Set(), 'files', 'edit', true, available);
    expect([...next]).toEqual(['project.file.read']);
  });

  test('and the cell reads as off rather than partial', () => {
    const fold = foldSelection('project', trimmed, new Set(['project.file.read']));
    const files = fold.areas.find((a) => a.area.key === 'files')!;
    expect(files.edit.leaves).toEqual([]);
    expect(files.edit.state).toBe('off');
    expect(files.view.state).toBe('on');
  });
});
