import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_SANDBOX_MOUNT_LIMIT,
  bestGrant,
  conflictOriginal,
  driveAccess,
  driveVolumeName,
  normalizeDrivePath,
  planDriveMounts,
} from './access';

const ALICE = '00000000-0000-4000-8000-00000000000a';
const BOB = '00000000-0000-4000-8000-00000000000b';

describe('driveAccess', () => {
  const alicePersonal = { kind: 'personal', ownerUserId: ALICE };

  test('a personal drive is refused to every other user, account owners included', () => {
    expect(driveAccess(alicePersonal, { userId: BOB, accountRole: 'member' })).toBe('none');
    expect(driveAccess(alicePersonal, { userId: BOB, accountRole: 'owner' })).toBe('none');
    expect(driveAccess(alicePersonal, { userId: ALICE, accountRole: 'member' })).toBe('manage');
  });

  test('a caller outside the drive account has no access, even to their own old personal drive', () => {
    expect(driveAccess(alicePersonal, { userId: ALICE, accountRole: null })).toBe('none');
    expect(driveAccess({ kind: 'company', ownerUserId: null }, { userId: BOB, accountRole: null })).toBe('none');
  });

  test('a shared personal drive gives exactly the shared access, never manage', () => {
    expect(driveAccess(alicePersonal, { userId: BOB, accountRole: 'member', granted: 'read' })).toBe('read');
    expect(driveAccess(alicePersonal, { userId: BOB, accountRole: 'owner', granted: 'write' })).toBe('write');
    expect(driveAccess(alicePersonal, { userId: BOB, accountRole: null, granted: 'write' })).toBe('none');
  });

  test('a company drive follows grants: a member without one has no access, owners and admins manage', () => {
    const drive = { kind: 'company', ownerUserId: null };
    expect(driveAccess(drive, { userId: BOB, accountRole: 'member' })).toBe('none');
    expect(driveAccess(drive, { userId: BOB, accountRole: 'member', granted: 'read' })).toBe('read');
    expect(driveAccess(drive, { userId: BOB, accountRole: 'member', granted: 'write' })).toBe('write');
    expect(driveAccess(drive, { userId: BOB, accountRole: 'admin' })).toBe('manage');
    expect(driveAccess(drive, { userId: BOB, accountRole: 'owner' })).toBe('manage');
    expect(driveAccess(drive, { userId: BOB, accountRole: null, granted: 'write' })).toBe('none');
  });

  test('an agent drive: members write, owners and admins manage', () => {
    const drive = { kind: 'agent', ownerUserId: null };
    expect(driveAccess(drive, { userId: BOB, accountRole: 'member' })).toBe('write');
    expect(driveAccess(drive, { userId: BOB, accountRole: 'admin' })).toBe('manage');
  });

  test('bestGrant keeps the more permissive grant', () => {
    expect(bestGrant('read', 'write')).toBe('write');
    expect(bestGrant(null, 'read')).toBe('read');
    expect(bestGrant(undefined, null)).toBeNull();
  });
});

describe('planDriveMounts', () => {
  const d = (name: string, n: number) => ({
    name,
    driveId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  });

  test('the owner drive is read-only with its From agents folder writable beside it; names never shadow fixed paths', () => {
    const plan = planDriveMounts([
      { drive: d('Me', 1), readOnly: true, role: 'drive' },
      { drive: d('From agents', 6), readOnly: false, role: 'drive' },
      { drive: d('Sales Docs', 2), readOnly: false, role: 'drive' },
      { drive: d('sales docs', 3), readOnly: false, role: 'drive' },
      { drive: d('default', 4), readOnly: false, role: 'agent' },
      { drive: d('My Drive', 5), readOnly: true, role: 'me' },
    ]);
    expect(plan.map((p) => [p.mountPath, p.readOnly, p.subdir ?? null])).toEqual([
      ['/drives/me', true, null],
      ['/drives/from-agents', false, '/From agents'],
      ['/drives/agent', false, null],
      ['/drives/me-drive', true, null],
      ['/drives/from-agents-drive', false, null],
      ['/drives/sales-docs', false, null],
      ['/drives/sales-docs-2', false, null],
    ]);
  });

  test('full write mounts the owner drive whole, with no separate From agents mount', () => {
    const plan = planDriveMounts([{ drive: d('My Drive', 5), readOnly: false, role: 'me' }]);
    expect(plan.map((p) => [p.mountPath, p.readOnly])).toEqual([['/drives/me', false]]);
  });

  test('a drive reached two ways mounts once, with the most permissive access', () => {
    const plan = planDriveMounts([
      { drive: d('Brand', 7), readOnly: true, role: 'drive' },
      { drive: d('Brand', 7), readOnly: false, role: 'drive' },
    ]);
    expect(plan.map((p) => [p.mountPath, p.readOnly])).toEqual([['/drives/brand', false]]);
  });

  test('never plans more mounts than a sandbox takes', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ drive: d(`Team ${i}`, i), readOnly: false, role: 'drive' as const }));
    expect(planDriveMounts(many)).toHaveLength(MAX_SESSION_DRIVES);
  });
});

test('normalizeDrivePath refuses traversal and normalizes the rest', () => {
  expect(normalizeDrivePath('../etc/passwd')).toBeNull();
  expect(normalizeDrivePath('/a/../../b')).toBeNull();
  expect(normalizeDrivePath('a//b/')).toBe('/a/b');
  expect(normalizeDrivePath(undefined)).toBe('/');
});

test('driveVolumeName is a valid, stable volume name', () => {
  const name = driveVolumeName('0f8a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b');
  expect(name).toBe('kd-0f8a2b3c4d5e4f608a9b');
  expect(name).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/);
});

test('conflictOriginal recognizes both merge and in-sandbox conflict copies', () => {
  expect(conflictOriginal('/notes/plan (conflict 2026-10-01 1405).md')).toBe('/notes/plan.md');
  expect(conflictOriginal('/a/plan (conflict 2026-10-01 1405 a3f9).md')).toBe('/a/plan.md');
  expect(conflictOriginal('/a/plan (conflict 2026-10-01 1405 2).md')).toBe('/a/plan.md');
  expect(conflictOriginal('/db/app (conflict 2026-10-01 1405).db')).toBe('/db/app.db');
  expect(conflictOriginal('/a/plan (conflict notes).md')).toBeNull();
  expect(conflictOriginal('/a (conflict 2026-10-01 1405)/plan.md')).toBeNull();
});
