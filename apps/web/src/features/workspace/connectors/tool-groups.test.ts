import { describe, expect, it } from 'bun:test';
import type { ConnectorAction, ConnectorPolicyAction } from '@kortix/sdk';

import {
  filterTools,
  groupPolicy,
  groupToolsByRisk,
  matchesToolSearch,
  TOOL_GROUP_LABEL,
  toolGroups,
  toolLabel,
} from './tool-groups';

function action(path: string, risk: string, description = ''): ConnectorAction {
  return { path, risk, description } as unknown as ConnectorAction;
}

describe('groupToolsByRisk', () => {
  it('puts only read tools in the read-only bucket', () => {
    const { readOnly, write } = groupToolsByRisk([
      action('search_emails', 'read'),
      action('send_email', 'write'),
      action('delete_thread', 'destructive'),
    ]);
    expect(readOnly.map((t) => t.path)).toEqual(['search_emails']);
    expect(write.map((t) => t.path)).toEqual(['send_email', 'delete_thread']);
  });

  it('treats an unknown risk as write, never as read-only', () => {
    const { readOnly, write } = groupToolsByRisk([action('mystery', 'something_new')]);
    expect(readOnly).toEqual([]);
    expect(write.map((t) => t.path)).toEqual(['mystery']);
  });

  it('preserves input order inside each group', () => {
    const { readOnly, write } = groupToolsByRisk([
      action('r1', 'read'),
      action('w1', 'write'),
      action('r2', 'read'),
      action('w2', 'destructive'),
    ]);
    expect(readOnly.map((t) => t.path)).toEqual(['r1', 'r2']);
    expect(write.map((t) => t.path)).toEqual(['w1', 'w2']);
  });

  it('handles an empty action list', () => {
    expect(groupToolsByRisk([])).toEqual({ readOnly: [], write: [] });
  });
});

describe('toolGroups', () => {
  it('labels the groups the way the detail screen renders them', () => {
    const groups = toolGroups([action('a', 'read'), action('b', 'write')]);
    expect(groups.map((g) => g.label)).toEqual([
      TOOL_GROUP_LABEL.readOnly,
      TOOL_GROUP_LABEL.write,
    ]);
  });

  it('drops an empty group instead of rendering an empty heading', () => {
    const groups = toolGroups([action('a', 'read')]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.key).toBe('readOnly');
  });

  it('returns nothing for a connector with no tools', () => {
    expect(toolGroups([])).toEqual([]);
  });

  it('puts read-only first so the safe half reads before the dangerous half', () => {
    const groups = toolGroups([action('w', 'destructive'), action('r', 'read')]);
    expect(groups[0]!.key).toBe('readOnly');
  });
});

describe('toolLabel', () => {
  it('turns a snake_case path into prose', () => {
    expect(toolLabel(action('search_emails', 'read'))).toBe('Search emails');
  });

  it('uses the last segment of a namespaced path', () => {
    expect(toolLabel(action('calendar/update-event', 'write'))).toBe('Update event');
    expect(toolLabel(action('gmail.send_email', 'write'))).toBe('Send email');
  });

  it('splits camelCase', () => {
    expect(toolLabel(action('updateCalendarEvents', 'write'))).toBe('Update calendar events');
  });

  it('falls back to the raw path when there is nothing to humanise', () => {
    expect(toolLabel(action('__', 'read'))).toBe('__');
  });

  it('never returns an empty string for a non-empty path', () => {
    for (const p of ['a', 'a_b', 'A', 'x/y']) {
      expect(toolLabel(action(p, 'read')).length).toBeGreaterThan(0);
    }
  });
});

describe('matchesToolSearch / filterTools', () => {
  it('matches on path and on description, case-insensitively', () => {
    const tool = action('send_email', 'write', 'Send or forward an email');
    expect(matchesToolSearch(tool, 'SEND_EM')).toBe(true);
    expect(matchesToolSearch(tool, 'forward')).toBe(true);
    expect(matchesToolSearch(tool, 'calendar')).toBe(false);
  });

  it('treats an empty or whitespace query as no filter', () => {
    const tools = [action('a', 'read'), action('b', 'write')];
    expect(filterTools(tools, '')).toHaveLength(2);
    expect(filterTools(tools, '   ')).toHaveLength(2);
  });

  it('tolerates a missing description', () => {
    const tool = { path: 'search', risk: 'read' } as unknown as ConnectorAction;
    expect(matchesToolSearch(tool, 'search')).toBe(true);
    expect(matchesToolSearch(tool, 'undefined')).toBe(false);
  });
});

describe('groupPolicy', () => {
  const tools = [action('a', 'write'), action('b', 'write')];

  it('reports the shared choice when every tool agrees', () => {
    const perTool: Record<string, ConnectorPolicyAction> = { a: 'always_run', b: 'always_run' };
    expect(groupPolicy(tools, perTool)).toBe('always_run');
  });

  it('reports default when no tool has an explicit choice', () => {
    expect(groupPolicy(tools, {})).toBe('default');
  });

  it('reports null when the group is split', () => {
    const perTool: Record<string, ConnectorPolicyAction> = { a: 'always_run', b: 'block' };
    expect(groupPolicy(tools, perTool)).toBeNull();
  });

  it('counts an unset tool as default when comparing', () => {
    const perTool: Record<string, ConnectorPolicyAction> = { a: 'always_run' };
    expect(groupPolicy(tools, perTool)).toBeNull();
  });

  it('reports null for an empty group', () => {
    expect(groupPolicy([], {})).toBeNull();
  });
});
