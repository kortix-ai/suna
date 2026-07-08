import { describe, expect, test } from 'bun:test';
import type { SecretGrant, ShareSubject } from '../../executor/share';
import {
  canManageFolder,
  folderIntentToVisibility,
  inheritedFolderIdsFor,
  isFolderVisibleTo,
  parseFolderName,
  serializeSessionFolder,
  type SessionFolderRow,
} from './session-folders';

const OWNER = 'user-owner';
const OTHER = 'user-other';

function subject(userId: string, groupIds: string[] = []): ShareSubject {
  return { userId, groupIds };
}

function folderRow(overrides: Partial<SessionFolderRow> = {}): SessionFolderRow {
  return {
    folderId: 'f-1',
    accountId: 'acc-1',
    projectId: 'proj-1',
    name: 'Growth',
    visibility: 'private',
    position: 0,
    createdBy: OWNER,
    createdAt: new Date('2026-07-01T00:00:00Z'),
    updatedAt: new Date('2026-07-02T00:00:00Z'),
    ...overrides,
  } as SessionFolderRow;
}

describe('isFolderVisibleTo', () => {
  test('private folder is visible only to its creator', () => {
    expect(isFolderVisibleTo(folderRow(), [], subject(OWNER))).toBe(true);
    expect(isFolderVisibleTo(folderRow(), [], subject(OTHER))).toBe(false);
  });

  test('project folder is visible to everyone', () => {
    expect(isFolderVisibleTo(folderRow({ visibility: 'project' }), [], subject(OTHER))).toBe(true);
  });

  test('restricted folder is visible to a granted member', () => {
    const grants: SecretGrant[] = [{ principalType: 'member', principalId: OTHER }];
    expect(isFolderVisibleTo(folderRow({ visibility: 'restricted' }), grants, subject(OTHER))).toBe(true);
    expect(isFolderVisibleTo(folderRow({ visibility: 'restricted' }), grants, subject('nope'))).toBe(false);
  });

  test('restricted folder is visible to a granted group member', () => {
    const grants: SecretGrant[] = [{ principalType: 'group', principalId: 'g-1' }];
    expect(isFolderVisibleTo(folderRow({ visibility: 'restricted' }), grants, subject(OTHER, ['g-1']))).toBe(true);
    expect(isFolderVisibleTo(folderRow({ visibility: 'restricted' }), grants, subject(OTHER, ['g-2']))).toBe(false);
  });

  test('creator always sees their restricted folder even without a grant', () => {
    expect(isFolderVisibleTo(folderRow({ visibility: 'restricted' }), [], subject(OWNER))).toBe(true);
  });
});

describe('canManageFolder', () => {
  test('creator can manage', () => {
    expect(canManageFolder(folderRow(), OWNER, false)).toBe(true);
  });

  test('non-creator member cannot manage', () => {
    expect(canManageFolder(folderRow(), OTHER, false)).toBe(false);
  });

  test('project manager can always manage', () => {
    expect(canManageFolder(folderRow(), OTHER, true)).toBe(true);
  });
});

describe('inheritedFolderIdsFor', () => {
  test('project folders inherit to everyone; private folders inherit to nobody', () => {
    const rows = [
      folderRow({ folderId: 'proj', visibility: 'project' }),
      folderRow({ folderId: 'priv', visibility: 'private' }),
    ];
    expect([...inheritedFolderIdsFor(rows, new Map(), subject(OTHER))]).toEqual(['proj']);
  });

  test('restricted folders inherit only to grantees', () => {
    const rows = [folderRow({ folderId: 'r', visibility: 'restricted' })];
    const grants = new Map<string, SecretGrant[]>([['r', [{ principalType: 'member', principalId: OTHER }]]]);
    expect([...inheritedFolderIdsFor(rows, grants, subject(OTHER))]).toEqual(['r']);
    expect([...inheritedFolderIdsFor(rows, grants, subject('nope'))]).toEqual([]);
  });
});

describe('folderIntentToVisibility', () => {
  test('project intent maps to project, no grants', () => {
    expect(folderIntentToVisibility({ mode: 'project' })).toEqual({ visibility: 'project', grants: [] });
  });

  test('private intent maps to private', () => {
    expect(folderIntentToVisibility({ mode: 'private', ownerId: OWNER })).toEqual({ visibility: 'private', grants: [] });
  });

  test('members intent maps to restricted + grants; empty collapses to private', () => {
    expect(folderIntentToVisibility({ mode: 'members', memberIds: [OTHER], groupIds: ['g-1'] })).toEqual({
      visibility: 'restricted',
      grants: [
        { principalType: 'member', principalId: OTHER },
        { principalType: 'group', principalId: 'g-1' },
      ],
    });
    expect(folderIntentToVisibility({ mode: 'members', memberIds: [], groupIds: [] })).toEqual({ visibility: 'private', grants: [] });
  });
});

describe('parseFolderName', () => {
  test('trims and returns valid names', () => {
    expect(parseFolderName('  Growth  ')).toBe('Growth');
  });

  test('rejects empty, non-string, and over-long names', () => {
    expect(parseFolderName('')).toBeNull();
    expect(parseFolderName('   ')).toBeNull();
    expect(parseFolderName(42)).toBeNull();
    expect(parseFolderName('x'.repeat(121))).toBeNull();
    expect(parseFolderName('x'.repeat(120))).toBe('x'.repeat(120));
  });
});

describe('serializeSessionFolder', () => {
  test('marks owner + manage rights + sharing for the creator', () => {
    const out = serializeSessionFolder(folderRow(), { viewerId: OWNER, canManageProject: false });
    expect(out.is_owner).toBe(true);
    expect(out.can_manage).toBe(true);
    expect(out.folder_id).toBe('f-1');
    expect(out.sharing).toEqual({ mode: 'private', ownerId: '' });
    expect(out.created_at).toBe('2026-07-01T00:00:00.000Z');
  });

  test('restricted folder serializes grants into a members intent', () => {
    const out = serializeSessionFolder(folderRow({ visibility: 'restricted' }), {
      viewerId: OWNER,
      canManageProject: false,
      grants: [{ principalType: 'member', principalId: OTHER }],
    });
    expect(out.sharing).toEqual({ mode: 'members', memberIds: [OTHER], groupIds: [] });
  });

  test('project manager can manage another users folder', () => {
    const out = serializeSessionFolder(folderRow(), { viewerId: OTHER, canManageProject: true });
    expect(out.can_manage).toBe(true);
  });
});
