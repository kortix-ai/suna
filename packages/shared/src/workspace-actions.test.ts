import { describe, expect, test } from 'bun:test';
import {
  LEGACY_ACTION_BY_WORKSPACE,
  WORKSPACE_ACTION_BY_LEGACY,
  isLegacyAction,
  isWorkspaceAction,
  toLegacyAction,
  toWorkspaceAction,
} from './workspace-actions';

const legacy = Object.keys(WORKSPACE_ACTION_BY_LEGACY);
const workspace = Object.values(WORKSPACE_ACTION_BY_LEGACY);

describe('workspace action alias map', () => {
  test('is a bijection: 84 legacy names, 84 distinct workspace names', () => {
    expect(legacy).toHaveLength(84);
    expect(new Set(workspace).size).toBe(84);
    expect(Object.keys(LEGACY_ACTION_BY_WORKSPACE)).toHaveLength(84);
  });

  test('every workspace name starts with workspace. and no legacy name does', () => {
    for (const w of workspace) expect(w.startsWith('workspace.')).toBe(true);
    for (const l of legacy) expect(l.startsWith('workspace.')).toBe(false);
  });

  test('round-trips both directions for every row', () => {
    for (const l of legacy) {
      expect(toLegacyAction(toWorkspaceAction(l))).toBe(l);
      expect(isLegacyAction(l)).toBe(true);
      expect(isWorkspaceAction(l)).toBe(false);
    }
    for (const w of workspace) {
      expect(toWorkspaceAction(toLegacyAction(w))).toBe(w);
      expect(isWorkspaceAction(w)).toBe(true);
    }
  });

  test('follows the naming rule in the module note', () => {
    const admin = ['billing', 'audit', 'member', 'group', 'policy', 'role', 'token', 'capture'];
    for (const [l, w] of Object.entries(WORKSPACE_ACTION_BY_LEGACY)) {
      const [head, ...rest] = l.split('.');
      let expected: string;
      if (l === 'project.create') expected = 'workspace.create';
      else if (head === 'project') expected = `workspace.${rest.join('.')}`;
      else if (head === 'account') expected = `workspace.account.${rest.join('.')}`;
      else if (admin.includes(head)) expected = `workspace.${l}`;
      else throw new Error(`no rule for ${l}`);
      expect(w as string).toBe(expected);
    }
  });

  test('leaves unknown, retired and already-converted names unchanged', () => {
    expect(toLegacyAction('project.room.read')).toBe('project.room.read');
    expect(toWorkspaceAction('project.cr.open')).toBe('project.cr.open');
    expect(toLegacyAction('nope')).toBe('nope');
    expect(toWorkspaceAction('workspace.read')).toBe('workspace.read');
    expect(toLegacyAction('project.read')).toBe('project.read');
    // Prototype keys are not actions.
    expect(isWorkspaceAction('constructor')).toBe(false);
    expect(isLegacyAction('toString')).toBe(false);
  });

  test('names the examples the design pins', () => {
    expect(toWorkspaceAction('project.read')).toBe('workspace.read');
    expect(toWorkspaceAction('billing.read')).toBe('workspace.billing.read');
    expect(toWorkspaceAction('project.session.start')).toBe('workspace.session.start');
    expect(toWorkspaceAction('project.settings.write')).toBe('workspace.settings.write');
    expect(toWorkspaceAction('account.write')).toBe('workspace.account.write');
  });
});
