import { describe, expect, test } from 'bun:test';
import type { ProjectSession, SessionFolder } from '@kortix/sdk/projects-client';

import { groupSessions, isAutoFolderKind } from './session-folder-grouping';

function session(overrides: Partial<ProjectSession> = {}): ProjectSession {
  return {
    session_id: 's-1',
    account_id: 'acc',
    project_id: 'proj',
    branch_name: 's-1',
    base_ref: 'main',
    sandbox_provider: 'daytona',
    sandbox_id: 's-1',
    sandbox_url: null,
    opencode_session_id: null,
    name: null,
    custom_name: null,
    agent_name: 'default',
    status: 'running',
    error: null,
    metadata: {},
    opencode_sessions: [],
    folder_id: null,
    created_at: '2026-07-01T00:00:00Z',
    updated_at: '2026-07-01T00:00:00Z',
    ...overrides,
  } as ProjectSession;
}

function folder(overrides: Partial<SessionFolder> = {}): SessionFolder {
  return {
    folder_id: 'f-1',
    project_id: 'proj',
    account_id: 'acc',
    name: 'Growth',
    visibility: 'private',
    position: 0,
    created_by: 'user-1',
    is_owner: true,
    can_manage: true,
    created_at: '2026-07-01T00:00:00Z',
    updated_at: '2026-07-01T00:00:00Z',
    ...overrides,
  };
}

describe('groupSessions', () => {
  test('files sessions into their manual folder', () => {
    const grouped = groupSessions(
      [session({ session_id: 'a', folder_id: 'f-1' }), session({ session_id: 'b' })],
      [folder()],
    );
    expect(grouped.folders).toHaveLength(1);
    expect(grouped.folders[0].sessions.map((s) => s.session_id)).toEqual(['a']);
    expect(grouped.loose.map((s) => s.session_id)).toEqual(['b']);
  });

  test('manual assignment beats source auto-grouping', () => {
    const grouped = groupSessions(
      [session({ session_id: 'a', folder_id: 'f-1', metadata: { source: 'slack' } })],
      [folder()],
    );
    expect(grouped.folders[0].sessions).toHaveLength(1);
    expect(grouped.auto).toHaveLength(0);
  });

  test('unfiled automation sessions group under auto folders in fixed order', () => {
    const grouped = groupSessions(
      [
        session({ session_id: 'w', metadata: { trigger_source: 'webhook', trigger_type: 'webhook' } }),
        session({ session_id: 'c', metadata: { trigger_source: 'cron', trigger_type: 'cron' } }),
        session({ session_id: 's', metadata: { source: 'slack' } }),
      ],
      [],
    );
    expect(grouped.auto.map((g) => g.kind)).toEqual(['slack', 'schedule', 'webhook']);
    expect(grouped.loose).toHaveLength(0);
  });

  test('empty auto folders are omitted; empty manual folders are kept', () => {
    const grouped = groupSessions([], [folder()]);
    expect(grouped.auto).toHaveLength(0);
    expect(grouped.folders).toHaveLength(1);
    expect(grouped.folders[0].sessions).toHaveLength(0);
  });

  test('folder_id pointing at an invisible folder degrades to unfiled', () => {
    const grouped = groupSessions(
      [
        session({ session_id: 'a', folder_id: 'gone' }),
        session({ session_id: 'b', folder_id: 'gone', metadata: { source: 'email' } }),
      ],
      [],
    );
    expect(grouped.loose.map((s) => s.session_id)).toEqual(['a']);
    expect(grouped.auto).toHaveLength(1);
    expect(grouped.auto[0].kind).toBe('email');
    expect(grouped.auto[0].sessions.map((s) => s.session_id)).toEqual(['b']);
  });

  test('manual folders sort by position, then created_at', () => {
    const grouped = groupSessions(
      [],
      [
        folder({ folder_id: 'b', name: 'B', position: 1 }),
        folder({ folder_id: 'a', name: 'A', position: 0 }),
        folder({ folder_id: 'c', name: 'C', position: 1, created_at: '2026-06-01T00:00:00Z' }),
      ],
    );
    expect(grouped.folders.map((g) => g.folder.folder_id)).toEqual(['a', 'c', 'b']);
  });
});

describe('isAutoFolderKind', () => {
  test('accepts known kinds, rejects everything else', () => {
    expect(isAutoFolderKind('slack')).toBe(true);
    expect(isAutoFolderKind('schedule')).toBe(true);
    expect(isAutoFolderKind('chat')).toBe(false);
    expect(isAutoFolderKind('f-uuid')).toBe(false);
  });
});
