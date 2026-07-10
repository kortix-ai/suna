import { describe, expect, test } from 'bun:test';
import {
  DOCK_MENU_ENTRIES,
  MORE_SHEET_GROUPS,
  chatActionItems,
  dockPillLabel,
  type DockMenuItem,
} from './dock-menu';

/** The exact page ids the deleted RightDrawerContent could reach. */
const LEGACY_RIGHT_DRAWER_PAGE_IDS = [
  'page:agents', 'page:skills', 'page:commands',
  'page:connectors', 'page:secrets-nav', 'page:channels-nav',
  'page:schedules', 'page:webhooks',
  'page:changes', 'page:files-nav', 'page:terminal', 'page:browser',
  'page:sandbox', 'page:dev', 'page:members', 'page:settings',
];

const dockItems = DOCK_MENU_ENTRIES.filter((e): e is DockMenuItem => e.kind === 'item');
const moreItems = MORE_SHEET_GROUPS.flatMap((g) => g.items);
const allPageIds = [...dockItems, ...moreItems].map((i) => i.pageId);

describe('dock menu reachability', () => {
  test('every legacy right-drawer page id is still reachable', () => {
    for (const id of LEGACY_RIGHT_DRAWER_PAGE_IDS) {
      expect(allPageIds).toContain(id);
    }
  });

  test('no page id is reachable from two places', () => {
    expect(new Set(allPageIds).size).toBe(allPageIds.length);
  });

  test('Files points at the project-level page, not the sandbox browser', () => {
    expect(allPageIds).toContain('page:files-nav');
    expect(allPageIds).not.toContain('page:files');
  });

  test('the dock itself stays short', () => {
    expect(dockItems.length).toBe(6);
  });
});

describe('dockPillLabel', () => {
  test('thread with a title shows the chat title', () => {
    expect(dockPillLabel({ inThread: true, chatTitle: 'Fix login', projectName: 'Habit' }))
      .toBe('Fix login');
  });
  test('thread without a title falls back to New chat', () => {
    expect(dockPillLabel({ inThread: true, chatTitle: null, projectName: 'Habit' }))
      .toBe('New chat');
  });
  test('project home shows the project name', () => {
    expect(dockPillLabel({ inThread: false, chatTitle: 'Fix login', projectName: 'Habit' }))
      .toBe('Habit');
  });
  test('project home without a name falls back to Project', () => {
    expect(dockPillLabel({ inThread: false, chatTitle: null, projectName: null }))
      .toBe('Project');
  });
});

describe('chatActionItems gating', () => {
  const full = {
    hasSession: true, hasProjectSession: true,
    canManageSharing: true,
  };
  const ids = (g: Parameters<typeof chatActionItems>[0]) => chatActionItems(g).map((a) => a.id);

  test('no session → no actions at all', () => {
    expect(chatActionItems({ ...full, hasSession: false })).toEqual([]);
  });
  test('full gates expose every action', () => {
    expect(ids(full)).toEqual([
      'rename', 'share', 'restart', 'export', 'compact',
      'viewChanges', 'diagnostics', 'archive', 'delete',
    ]);
  });
  test('no project session hides rename, share and delete', () => {
    const got = ids({ ...full, hasProjectSession: false });
    expect(got).not.toContain('rename');
    expect(got).not.toContain('share');
    expect(got).not.toContain('delete');
    expect(got).toContain('restart');
  });
  test('sharing disabled hides only share', () => {
    const got = ids({ ...full, canManageSharing: false });
    expect(got).not.toContain('share');
    expect(got).toContain('rename');
  });
  test('"Open change request" is not in the sheet — it lives on the dock menu', () => {
    expect(ids(full)).not.toContain('changeRequest');
  });
  test('delete is the only destructive action and comes last', () => {
    const actions = chatActionItems(full);
    expect(actions.filter((a) => a.destructive).map((a) => a.id)).toEqual(['delete']);
    expect(actions[actions.length - 1].id).toBe('delete');
  });
  test('secondary actions are exactly the ones hidden behind More', () => {
    const secondary = chatActionItems(full).filter((a) => a.secondary).map((a) => a.id);
    expect(secondary).toEqual(['viewChanges', 'diagnostics', 'archive']);
  });
});
