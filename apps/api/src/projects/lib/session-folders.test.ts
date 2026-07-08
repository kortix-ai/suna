import { describe, expect, test } from 'bun:test';
import {
  canManageFolder,
  isFolderVisibleTo,
  parseFolderName,
  parseFolderVisibility,
  projectVisibleFolderIds,
  serializeSessionFolder,
  type SessionFolderRow,
} from './session-folders';

const OWNER = 'user-owner';
const OTHER = 'user-other';

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
    expect(isFolderVisibleTo(folderRow(), OWNER)).toBe(true);
    expect(isFolderVisibleTo(folderRow(), OTHER)).toBe(false);
  });

  test('project folder is visible to everyone', () => {
    expect(isFolderVisibleTo(folderRow({ visibility: 'project' }), OTHER)).toBe(true);
  });

  test('private folder with no creator is visible to nobody', () => {
    expect(isFolderVisibleTo(folderRow({ createdBy: null }), OWNER)).toBe(false);
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

describe('projectVisibleFolderIds', () => {
  test('collects only project-visible folder ids', () => {
    const ids = projectVisibleFolderIds([
      folderRow({ folderId: 'a', visibility: 'project' }),
      folderRow({ folderId: 'b', visibility: 'private' }),
      folderRow({ folderId: 'c', visibility: 'project' }),
    ]);
    expect([...ids].sort()).toEqual(['a', 'c']);
  });

  test('empty input yields empty set', () => {
    expect(projectVisibleFolderIds([]).size).toBe(0);
  });
});

describe('parseFolderVisibility', () => {
  test('accepts private and project only', () => {
    expect(parseFolderVisibility('private')).toBe('private');
    expect(parseFolderVisibility('project')).toBe('project');
    expect(parseFolderVisibility('restricted')).toBeNull();
    expect(parseFolderVisibility(undefined)).toBeNull();
    expect(parseFolderVisibility(1)).toBeNull();
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
  test('marks owner + manage rights for the creator', () => {
    const out = serializeSessionFolder(folderRow(), { viewerId: OWNER, canManageProject: false });
    expect(out.is_owner).toBe(true);
    expect(out.can_manage).toBe(true);
    expect(out.folder_id).toBe('f-1');
    expect(out.created_at).toBe('2026-07-01T00:00:00.000Z');
  });

  test('non-owner without manage rights cannot manage', () => {
    const out = serializeSessionFolder(folderRow(), { viewerId: OTHER, canManageProject: false });
    expect(out.is_owner).toBe(false);
    expect(out.can_manage).toBe(false);
  });

  test('project manager can manage another user\'s folder', () => {
    const out = serializeSessionFolder(folderRow(), { viewerId: OTHER, canManageProject: true });
    expect(out.can_manage).toBe(true);
  });
});
