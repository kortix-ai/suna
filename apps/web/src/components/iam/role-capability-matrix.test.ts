import { describe, expect, test } from 'bun:test';

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  applyBulk,
  applyCell,
  applyLeaf,
  buildAreaTable,
  expandFold,
  foldSelection,
  unmappedLeaves,
} from './role-capability-matrix';
import type { CapabilityScope } from './role-capability-matrix';
import type { Permission } from '@/lib/iam-client';

/**
 * The matrix is a DISPLAY over the same leaf strings the IAM engine reads, so
 * the only thing that can break a role is the fold dropping a leaf.
 *
 * The catalog is no longer copied into this file. It is PARSED OUT OF THE
 * MIGRATIONS that seed `kortix.permissions` — the same rows
 * `GET /accounts/:id/iam/permissions` serves. The old copy was a hand-kept
 * mirror that had already drifted (it still listed `project.cr.open` /
 * `project.cr.merge`, which the canonical catalog collapsed into
 * `project.gitops.*`), and a drift alarm that drifts is not an alarm.
 */
const MIGRATIONS_DIR = join(import.meta.dir, '../../../../../packages/db/migrations');

/** Every `INSERT INTO kortix.permissions (...) VALUES ...` row in the migration
 *  tree, in file order. Handles both column orders in use. */
function seededCatalog(): Permission[] {
  const out = new Map<string, Permission>();
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    const inserts = sql.matchAll(
      /INSERT INTO kortix\.permissions\s*\(([^)]*)\)\s*VALUES([\s\S]*?);/gi,
    );
    for (const insert of inserts) {
      const columns = insert[1].split(',').map((c) => c.trim().replace(/"/g, ''));
      for (const row of insert[2].matchAll(/\(([\s\S]*?)\)(?=\s*(?:,\s*\(|\s*ON CONFLICT|\s*$))/gi)) {
        const values = splitValues(row[1]);
        if (values.length !== columns.length) continue;
        const record: Record<string, string> = {};
        columns.forEach((column, i) => (record[column] = values[i]));
        if (!record.action) continue;
        out.set(unquote(record.action), {
          action: unquote(record.action),
          scope_type: unquote(record.scope_type) as Permission['scope_type'],
          resource_type: unquote(record.resource_type),
          delegable: /true/i.test(record.delegable ?? 'true'),
          description: unquote(record.description ?? "''"),
          area: unquote(record.area),
          level: unquote(record.level),
          implies: parseArray(record.implies ?? "'{}'"),
        });
      }
    }
  }
  return [...out.values()];
}

/** Split a SQL tuple body on top-level commas, respecting quotes and nesting. */
function splitValues(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quoted = false;
  let current = '';
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (quoted) {
      current += ch;
      if (ch === "'" && body[i + 1] === "'") {
        current += body[++i];
      } else if (ch === "'") {
        quoted = false;
      }
      continue;
    }
    if (ch === "'") { quoted = true; current += ch; continue; }
    if (ch === '(' || ch === '[') depth += 1;
    if (ch === ')' || ch === ']') depth -= 1;
    if (ch === ',' && depth === 0) { out.push(current.trim()); current = ''; continue; }
    current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

function unquote(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("'")) return trimmed;
  return trimmed.slice(1, trimmed.lastIndexOf("'")).replace(/''/g, "'");
}

function parseArray(raw: string): string[] {
  const array = raw.match(/ARRAY\[([\s\S]*?)\]/i);
  if (!array) return [];
  return splitValues(array[1]).map(unquote).filter(Boolean);
}

const CATALOG = seededCatalog();
const PROJECT_LEAVES = CATALOG.filter((p) => p.scope_type === 'project').map((p) => p.action);
const ACCOUNT_LEAVES = CATALOG.filter((p) => p.scope_type === 'account').map((p) => p.action);

/** The exact leaf sets the SYSTEM roles are seeded with — parsed from the same
 *  migration, so `GET /iam/roles/:id/permissions` and this fixture cannot drift.
 *  These are what the role editor seeds the matrix with when someone clones a
 *  built-in. */
function seededRolePermissions(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    for (const block of sql.matchAll(
      /INSERT INTO kortix\.iam_role_actions[\s\S]*?FROM \(VALUES([\s\S]*?)\)\s*AS/gi,
    )) {
      for (const row of block[1].matchAll(/\('([^']+)',\s*'([^']+)',\s*'([^']+)'\)/g)) {
        const key = `${row[1]}:${row[2]}`;
        out.set(key, [...(out.get(key) ?? []), row[3]]);
      }
    }
    // The single-row `SELECT r.role_id, '<action>' FROM kortix.iam_roles r WHERE key = '<key>'`
    // shape used by additive follow-up migrations. Post-cutover ones target the
    // BASE TABLE `kortix.role_permissions`: `kortix.iam_role_actions` is a view
    // now, and a view cannot take ON CONFLICT.
    for (const one of sql.matchAll(
      /INSERT INTO kortix\.(?:iam_role_actions|role_permissions) \(role_id, action\)\s*SELECT r\.role_id, '([^']+)'[\s\S]*?r\.key = '([^']+)'[\s\S]*?r\.scope_type = '([^']+)'/gi,
    )) {
      const key = `${one[2]}:${one[3]}`;
      out.set(key, [...(out.get(key) ?? []), one[1]]);
    }
  }
  return out;
}

const SEEDED_ROLES = seededRolePermissions();
const roleActions = (key: string, scope: CapabilityScope) => {
  const actions = SEEDED_ROLES.get(`${key}:${scope}`);
  if (!actions || actions.length === 0) throw new Error(`no seeded actions for ${key}:${scope}`);
  return actions;
};

const BUILTIN_SETS: { name: string; scope: CapabilityScope; actions: string[] }[] = [
  { name: 'manager', scope: 'project', actions: roleActions('manager', 'project') },
  { name: 'member (project floor)', scope: 'project', actions: roleActions('member', 'project') },
  { name: 'owner', scope: 'account', actions: roleActions('owner', 'account') },
  { name: 'admin', scope: 'account', actions: roleActions('admin', 'account') },
  { name: 'member', scope: 'account', actions: roleActions('member', 'account') },
];

const PROJECT_MANAGER = roleActions('manager', 'project');
const ACCOUNT_OWNER = roleActions('owner', 'account');

function sorted(set: Iterable<string>): string[] {
  return [...set].sort();
}

// ─── The mapping itself ─────────────────────────────────────────────────────

describe('the area table covers the catalog', () => {
  test('the seeded catalog is the shape the matrix expects (drift alarm)', () => {
    expect(PROJECT_LEAVES.length).toBe(45);
    expect(ACCOUNT_LEAVES.length).toBe(27);
    // The retired spellings must not come back: `project.cr.*` collapsed into
    // `project.gitops.*` (the same capability named twice), and `trigger.*` was
    // cataloged, validated, in no role and asserted by no route.
    expect(PROJECT_LEAVES.filter((a) => a.startsWith('project.cr.'))).toEqual([]);
    expect(CATALOG.filter((p) => /^trigger\./.test(p.action))).toEqual([]);
    expect(new Set(PROJECT_LEAVES).size).toBe(PROJECT_LEAVES.length);
    expect(new Set(ACCOUNT_LEAVES).size).toBe(ACCOUNT_LEAVES.length);
  });

  // `admin`-level leaves are deliberately Advanced-only — they are the
  // escalation leaves, every one `delegable: false`, and a cell would hand them
  // out on an "Edit everything" click.
  test('every project leaf is in a cell except the admin-level ones', () => {
    expect(unmappedLeaves('project', CATALOG)).toEqual(['project.credentials.issue']);
    expect(CATALOG.find((p) => p.action === 'project.credentials.issue')?.level).toBe('admin');
  });

  test('the only unmapped account leaf is the super-admin grant', () => {
    expect(unmappedLeaves('account', CATALOG)).toEqual(['member.super_admin.grant']);
    expect(CATALOG.find((p) => p.action === 'member.super_admin.grant')?.level).toBe('admin');
  });

  test('the super-admin grant is non-delegable — the server ceiling backs the UI choice', () => {
    expect(CATALOG.find((p) => p.action === 'member.super_admin.grant')?.delegable).toBe(false);
  });

  test('no leaf appears in two cells', () => {
    for (const scope of ['project', 'account'] as const) {
      const seen = new Set<string>();
      for (const area of buildAreaTable(scope, CATALOG)) {
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
      for (const area of buildAreaTable(scope, CATALOG)) {
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
    expect(fold.totalCount).toBe(45);
  });

  test('a full project role round-trips', () => {
    const selected = new Set(PROJECT_LEAVES);
    const fold = foldSelection('project', CATALOG, selected);
    expect(sorted(expandFold(fold))).toEqual(sorted(selected));
    expect(fold.selectedCount).toBe(45);
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

  test('the built-in manager reads as fully checked in every cell', () => {
    const fold = foldSelection('project', CATALOG, new Set(PROJECT_MANAGER));
    // The `git` cell used to read `partial` because the client table still
    // carried `project.cr.open` / `project.cr.merge`, which no role ever held.
    // The catalog dropped them, so the manager is now on everywhere.
    expect(fold.areas.filter((a) => a.partial).map((a) => a.area.key)).toEqual([]);
    expect(fold.areas.every((a) => a.view.state === 'on' && a.edit.state === 'on')).toBe(true);
  });

  test('the member floor role reads as partial where §7 splits a cell', () => {
    expect(cell('project', roleActions('member', 'project'), 'project')).toEqual({
      view: 'on',
      edit: 'off',
      partial: false,
    });
    // start + stop granted, bindings.write not.
    expect(cell('project', roleActions('member', 'project'), 'sessions').edit).toBe('partial');
    // only command.read out of six Customize reads.
    expect(cell('project', roleActions('member', 'project'), 'customize').view).toBe('partial');
    expect(cell('project', roleActions('member', 'project'), 'git')).toEqual({
      view: 'on',
      edit: 'partial',
      partial: true,
    });
    expect(foldSelection('project', CATALOG, new Set(roleActions('member', 'project'))).needsAdvanced).toBe(true);
  });

  test('an area with no leaves on one side reads as off, never partial', () => {
    expect(cell('account', roleActions('admin', 'account'), 'audit')).toEqual({
      view: 'on',
      edit: 'off',
      partial: false,
    });
    expect(cell('account', roleActions('admin', 'account'), 'projects')).toEqual({
      view: 'off',
      edit: 'on',
      partial: false,
    });
  });
});

// ─── applyCell: implications ────────────────────────────────────────────────

describe('applyCell — Edit implies View', () => {
  test('checking Edit checks View', () => {
    const next = applyCell('project', new Set(), 'files', 'edit', true, CATALOG);
    expect(sorted(next)).toEqual(['project.file.read', 'project.file.write']);
  });

  test('checking Edit on Customize pulls in all six reads', () => {
    const next = applyCell('project', new Set(), 'customize', 'edit', true, CATALOG);
    expect(next.has('project.customize.read')).toBe(true);
    expect(next.has('project.agent.read')).toBe(true);
    expect(next.has('project.secret.read')).toBe(true);
    expect(next.size).toBe(13);
  });

  test('unchecking View unchecks Edit', () => {
    const on = applyCell('project', new Set(), 'members', 'edit', true, CATALOG);
    expect(sorted(on)).toEqual(['project.members.manage', 'project.members.read']);
    const off = applyCell('project', on, 'members', 'view', false, CATALOG);
    expect([...off]).toEqual([]);
  });

  test('checking View alone does not grant Edit', () => {
    const next = applyCell('project', new Set(), 'files', 'view', true, CATALOG);
    expect([...next]).toEqual(['project.file.read']);
  });

  test('unchecking Edit leaves View in place', () => {
    const on = applyCell('project', new Set(), 'files', 'edit', true, CATALOG);
    const off = applyCell('project', on, 'files', 'edit', false, CATALOG);
    expect([...off]).toEqual(['project.file.read']);
  });

  test('account Members Edit implies Members View', () => {
    const next = applyCell('account', new Set(), 'members', 'edit', true, CATALOG);
    expect(next.has('member.read')).toBe(true);
    expect(next.has('member.invite')).toBe(true);
    expect(next.has('member.super_admin.grant')).toBe(false);
  });
});

describe('applyLeaf — delete implies write', () => {
  test('project.delete pulls in project.write and project.read', () => {
    const next = applyLeaf('project', new Set(), 'project.delete', true, CATALOG);
    expect(sorted(next)).toEqual(['project.delete', 'project.read', 'project.write']);
  });

  test('dropping project.write drops project.delete', () => {
    const on = applyLeaf('project', new Set(), 'project.delete', true, CATALOG);
    const off = applyLeaf('project', on, 'project.write', false, CATALOG);
    expect(sorted(off)).toEqual(['project.read']);
  });

  test('account.delete pulls in account.write and account.read', () => {
    const next = applyLeaf('account', new Set(), 'account.delete', true, CATALOG);
    expect(sorted(next)).toEqual(['account.delete', 'account.read', 'account.write']);
  });
});

describe('applyCell — a push rewrites Files, Customize and Triggers', () => {
  test('checking Git & Reviews Edit sets the file, customize and trigger write leaves', () => {
    const next = applyCell('project', new Set(), 'git', 'edit', true, CATALOG);
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

  test('unchecking Files Edit clears gitops push and merge', () => {
    const on = applyCell('project', new Set(), 'git', 'edit', true, CATALOG);
    const off = applyCell('project', on, 'files', 'edit', false, CATALOG);
    expect(off.has('project.gitops.push')).toBe(false);
    expect(off.has('project.gitops.merge')).toBe(false);
    // Submitting and acting on reviews do not rewrite the repo.
    expect(off.has('project.review.submit')).toBe(true);
    expect(off.has('project.review.act')).toBe(true);
    expect(off.has('project.file.write')).toBe(false);
    expect(off.has('project.file.read')).toBe(true);
  });

  test('unchecking Customize Edit clears the same two git leaves', () => {
    const on = applyCell('project', new Set(), 'git', 'edit', true, CATALOG);
    const off = applyCell('project', on, 'customize', 'edit', false, CATALOG);
    expect(off.has('project.gitops.push')).toBe(false);
    expect(off.has('project.gitops.merge')).toBe(false);
    expect(off.has('project.customize.read')).toBe(true);
  });

  test('the Git row carries the note that explains it', () => {
    const git = buildAreaTable('project', CATALOG).find((a) => a.key === 'git')!;
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

  test('Edit everything grants the whole project catalog except the admin leaves', () => {
    const next = applyBulk('project', new Set(), 'edit-all', CATALOG);
    const adminLeaves = CATALOG.filter((p) => p.scope_type === 'project' && p.level === 'admin').map(
      (p) => p.action,
    );
    expect(adminLeaves.length).toBeGreaterThan(0);
    expect(sorted(next)).toEqual(sorted(PROJECT_LEAVES.filter((a) => !adminLeaves.includes(a))));
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

  test('a leaf missing from the catalog cannot be granted at all', () => {
    // Stronger than it used to be: the table is BUILT from the catalog, so a
    // leaf the API no longer publishes is not merely skipped on add — it has no
    // cell to be checked from.
    const edit = applyCell('project', new Set(), 'files', 'edit', true, trimmed);
    expect(edit.has('project.file.write')).toBe(false);
    const view = applyCell('project', new Set(), 'files', 'view', true, trimmed);
    expect([...view]).toEqual(['project.file.read']);
  });

  test('and the cell reads as off rather than partial', () => {
    const fold = foldSelection('project', trimmed, new Set(['project.file.read']));
    const files = fold.areas.find((a) => a.area.key === 'files')!;
    expect(files.edit.leaves).toEqual([]);
    expect(files.edit.state).toBe('off');
    expect(files.view.state).toBe('on');
  });
});
