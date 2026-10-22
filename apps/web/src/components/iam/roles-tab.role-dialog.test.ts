import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { IamRole } from '@/lib/iam-client';
import { slugifyKey, type RoleDialogProps } from './roles-tab';

const noop = () => {};

const ROLE: IamRole = {
  role_id: 'r1',
  key: 'auditor',
  name: 'Auditor',
  description: 'Read-only reviewer',
  resource_type: 'project',
  is_system: false,
  account_id: null,
};

// The dialog's mutation and query wiring is hook-bound, and `apps/web`'s bun
// tests have no DOM harness (the precedent is `general-tab.rename.test.tsx`,
// which pins the same kind of wiring by scanning the source the component
// runs). What CAN be behavior-tested here is: the key auto-generation math,
// and the prop contract — enforced by `tsc --noEmit`, which rejects the
// impossible prop combinations the union exists to forbid. The runtime
// assertions below only keep the file a valid bun test; the `@ts-expect-error`
// directives are the enforcement, and tsc fails when one stops matching.

describe('slugifyKey — the create dialog key auto-generation', () => {
  test('a name becomes a lowercase underscore key', () => {
    expect(slugifyKey('Auditor Role')).toBe('auditor_role');
  });

  test('separators and symbols collapse, edges trimmed', () => {
    expect(slugifyKey('  QA / Release -- Sign-off!! ')).toBe('qa_release_sign_off');
  });

  test('the key caps at 64 characters', () => {
    expect(slugifyKey('x'.repeat(80)).length).toBe(64);
  });

  test('a name of only symbols yields an empty key (submit stays disabled)', () => {
    expect(slugifyKey('///')).toBe('');
  });
});

describe('RoleDialog props — the discriminated union', () => {
  test('create carries an optional prefill and no role', () => {
    const create: RoleDialogProps = {
      accountId: 'a1',
      mode: 'create',
      prefill: { name: 'Auditor copy', resourceType: 'project', actions: ['project.read'] },
      open: true,
      onOpenChange: noop,
    };
    const bareCreate: RoleDialogProps = {
      accountId: 'a1',
      mode: 'create',
      open: true,
      onOpenChange: noop,
    };
    expect(create.mode).toBe('create');
    expect(bareCreate.mode).toBe('create');
  });

  test('edit and view always carry the role they open', () => {
    const edit: RoleDialogProps = {
      accountId: 'a1',
      mode: 'edit',
      role: ROLE,
      open: true,
      onOpenChange: noop,
    };
    const view: RoleDialogProps = {
      accountId: 'a1',
      mode: 'view',
      role: ROLE,
      open: true,
      onOpenChange: noop,
    };
    expect(edit.mode).toBe('edit');
    expect(view.mode).toBe('view');
  });

  test('a create dialog with a role is a type error', () => {
    const create: RoleDialogProps = {
      accountId: 'a1',
      mode: 'create',
      // @ts-expect-error — create never carries a role; the union rejects it.
      role: ROLE,
      open: true,
      onOpenChange: noop,
    };
    expect(create.mode).toBe('create');
  });

  test('an edit dialog without a role is a type error', () => {
    // @ts-expect-error — edit always carries the role it opens.
    const edit: RoleDialogProps = { accountId: 'a1', mode: 'edit', open: true, onOpenChange: noop };
    expect(edit.mode).toBe('edit');
  });

  test('a view dialog without a role is a type error', () => {
    // @ts-expect-error — view always carries the role it opens.
    const view: RoleDialogProps = { accountId: 'a1', mode: 'view', open: true, onOpenChange: noop };
    expect(view.mode).toBe('view');
  });
});

// ─── The wiring the dialog runs (source scan, comments stripped) ───────────

const source = readFileSync(join(import.meta.dir, 'roles-tab.tsx'), 'utf8');
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const dialogStart = code.indexOf('function RoleDialog(');
const dialogEnd = code.indexOf('\nfunction ', dialogStart);
const dialog = dialogStart < 0 || dialogEnd < 0 ? '' : code.slice(dialogStart, dialogEnd);

const updateStart = dialog.indexOf('const updateMutation = useMutation({');
const updateEnd = dialog.indexOf('\n  });', updateStart);
const updateBlock = updateStart < 0 || updateEnd < 0 ? '' : dialog.slice(updateStart, updateEnd);

describe('RoleDialog wiring', () => {
  test('the scan found the dialog and its update mutation', () => {
    expect(dialog.length).toBeGreaterThan(0);
    expect(updateBlock.length).toBeGreaterThan(0);
  });

  test('no non-null role assertion survives in the dialog', () => {
    expect(dialog).not.toContain('role!');
  });

  test('create prefill seeds the dialog fields', () => {
    expect(dialog).toContain("useState(role?.name ?? prefill?.name ?? '')");
    expect(dialog).toContain('prefill ? slugifyKey(prefill.name)');
    expect(dialog).toContain('role?.resource_type ?? prefill?.resourceType');
    expect(dialog).toContain('new Set(prefill?.actions ?? [])');
  });

  test('the key auto-generates from the name only while the key is untouched', () => {
    const handler = dialog.slice(
      dialog.indexOf('function handleNameChange'),
      dialog.indexOf('}', dialog.indexOf('function handleNameChange')),
    );
    expect(handler).toContain('!isEdit && !keyTouched');
    expect(handler).toContain('slugifyKey(value)');
  });

  test('unchanged metadata skips updateRole; permissions always save', () => {
    const guard = updateBlock.indexOf('if (nameChanged || descChanged) {');
    const guardEnd = updateBlock.indexOf('}', guard);
    const guarded = updateBlock.slice(guard, guardEnd);
    expect(guarded).toContain('await updateRole(');
    expect(guarded).not.toContain('updateRolePermissions');
    // The permission save runs after the metadata update, guarded or not.
    expect(updateBlock.indexOf('await updateRole(')).toBeLessThan(
      updateBlock.indexOf('await updateRolePermissions('),
    );
  });

  test('view fetches the grant set but renders no submit', () => {
    expect(dialog).toContain('const hasExistingRole = props.mode !== ');
    expect(dialog).toMatch(
      /!isView && \(\s*<Button[\s\S]{0,200}?mutation\.mutate\(\)/,
    );
  });
});
