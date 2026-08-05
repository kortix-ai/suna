import type { ConnectorAction } from '@kortix/sdk';
import { describe, expect, test } from 'bun:test';

import { filterActions, groupToolsByRisk, toolRowText } from './tool-groups';

const action = (path: string, risk: ConnectorAction['risk']): ConnectorAction => ({
  path,
  name: path,
  description: '',
  risk,
  inputSchema: null,
});

describe('groupToolsByRisk', () => {
  test('read actions group separately from write and destructive', () => {
    const groups = groupToolsByRisk([
      action('get_issue', 'read'),
      action('create_issue', 'write'),
      action('delete_issue', 'destructive'),
    ]);
    expect(groups.map((g) => g.key)).toEqual(['read', 'write']);
    expect(groups[0]?.actions.map((a) => a.path)).toEqual(['get_issue']);
    expect(groups[1]?.actions.map((a) => a.path)).toEqual(['create_issue', 'delete_issue']);
  });

  test('an empty group is omitted, not rendered blank', () => {
    expect(groupToolsByRisk([action('get_issue', 'read')]).map((g) => g.key)).toEqual(['read']);
  });

  test('read-only group comes first — it is the safe default reading order', () => {
    const groups = groupToolsByRisk([action('a', 'destructive'), action('b', 'read')]);
    expect(groups[0]?.key).toBe('read');
  });

  test('labels are the user-facing wording', () => {
    const groups = groupToolsByRisk([action('a', 'read'), action('b', 'write')]);
    expect(groups.map((g) => g.label)).toEqual(['Read-only tools', 'Write tools']);
  });

  test('actions keep their input order inside a group', () => {
    const groups = groupToolsByRisk([action('z', 'read'), action('a', 'read')]);
    expect(groups[0]?.actions.map((a) => a.path)).toEqual(['z', 'a']);
  });

  test('no actions at all — no groups, so the tools tab shows one empty state', () => {
    expect(groupToolsByRisk([])).toEqual([]);
  });
});

describe('toolRowText', () => {
  test('name, path and description are all distinct — all three are kept', () => {
    expect(
      toolRowText({ ...action('send_email', 'write'), name: 'Send email', description: 'Sends it' }),
    ).toEqual({ title: 'Send email', path: 'send_email', description: 'Sends it' });
  });

  // The live `petstore` fixture derives both from one OpenAPI `summary`, so
  // all 19 of its rows would otherwise print the same sentence twice.
  test('a description that only repeats the name is dropped', () => {
    expect(
      toolRowText({
        ...action('deletepet', 'destructive'),
        name: 'Deletes a pet.',
        description: 'Deletes a pet.',
      }),
    ).toEqual({ title: 'Deletes a pet.', path: 'deletepet', description: null });
  });

  test('the repeat check ignores case and surrounding space', () => {
    expect(
      toolRowText({ ...action('a', 'read'), name: 'Get thing', description: '  get THING ' })
        .description,
    ).toBeNull();
  });

  test('no name — the path becomes the title and is not printed twice', () => {
    expect(toolRowText({ ...action('get_thing', 'read'), name: '', description: 'Reads' })).toEqual({
      title: 'get_thing',
      path: null,
      description: 'Reads',
    });
  });

  test('no description at all', () => {
    expect(toolRowText(action('get_thing', 'read')).description).toBeNull();
  });
});

describe('filterActions', () => {
  const tools: ConnectorAction[] = [
    { ...action('send_email', 'write'), name: 'Send email', description: 'Deliver a message' },
    { ...action('list_labels', 'read'), name: 'List labels', description: 'Read every folder' },
  ];

  test('an empty query keeps every tool — and the same array identity is not required', () => {
    expect(filterActions(tools, '').map((t) => t.path)).toEqual(['send_email', 'list_labels']);
  });

  test('whitespace is not a query', () => {
    expect(filterActions(tools, '   ')).toHaveLength(2);
  });

  test('matches the path', () => {
    expect(filterActions(tools, 'send_').map((t) => t.path)).toEqual(['send_email']);
  });

  test('matches the display name, which is what the row prints', () => {
    expect(filterActions(tools, 'List la').map((t) => t.path)).toEqual(['list_labels']);
  });

  test('matches the description — the words a reader actually recognises', () => {
    expect(filterActions(tools, 'folder').map((t) => t.path)).toEqual(['list_labels']);
  });

  test('case does not matter', () => {
    expect(filterActions(tools, 'SEND_EMAIL').map((t) => t.path)).toEqual(['send_email']);
  });

  test('no match returns empty — "nothing matched" is not "nothing exists"', () => {
    expect(filterActions(tools, 'zzz')).toEqual([]);
    expect(tools).toHaveLength(2);
  });
});
