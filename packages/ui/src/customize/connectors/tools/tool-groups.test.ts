import type { ConnectorAction } from '@kortix/sdk';
import { describe, expect, test } from 'bun:test';

import { testUiTranslator } from '../../../test-utils/intl';
import { filterActions, groupToolsByRisk, humanizeToolName, toolBucket, toolRowText } from './tool-groups';

const action = (path: string, risk: ConnectorAction['risk']): ConnectorAction => ({
  path,
  name: path,
  description: '',
  risk,
  inputSchema: null,
});

describe('groupToolsByRisk', () => {
  test('read actions group separately from write and destructive', () => {
    const groups = groupToolsByRisk(
      [
        action('get_issue', 'read'),
        action('create_issue', 'write'),
        action('delete_issue', 'destructive'),
      ],
      testUiTranslator,
    );
    expect(groups.map((g) => g.key)).toEqual(['read', 'write']);
    expect(groups[0]?.actions.map((a) => a.path)).toEqual(['get_issue']);
    expect(groups[1]?.actions.map((a) => a.path)).toEqual(['create_issue', 'delete_issue']);
  });

  test('an empty group is omitted, not rendered blank', () => {
    expect(
      groupToolsByRisk([action('get_issue', 'read')], testUiTranslator).map((g) => g.key),
    ).toEqual(['read']);
  });

  test('read-only group comes first — it is the safe default reading order', () => {
    const groups = groupToolsByRisk(
      [action('a', 'destructive'), action('b', 'read')],
      testUiTranslator,
    );
    expect(groups[0]?.key).toBe('read');
  });

  test('labels are the user-facing wording', () => {
    const groups = groupToolsByRisk([action('a', 'read'), action('b', 'write')], testUiTranslator);
    expect(groups.map((g) => g.label)).toEqual(['Read-only tools', 'Write tools']);
  });

  test('actions keep their input order inside a group', () => {
    const groups = groupToolsByRisk([action('z', 'read'), action('a', 'read')], testUiTranslator);
    expect(groups[0]?.actions.map((a) => a.path)).toEqual(['z', 'a']);
  });

  test('no actions at all — no groups, so the tools tab shows one empty state', () => {
    expect(groupToolsByRisk([], testUiTranslator)).toEqual([]);
  });
});

describe('toolRowText', () => {
  test('name, path and description are all distinct — all three are kept', () => {
    expect(
      toolRowText({
        ...action('send_email', 'write'),
        name: 'Send email',
        description: 'Sends it',
      }),
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

  test('no name — the path becomes a title in words, and the raw id stays beside it', () => {
    expect(toolRowText({ ...action('get_thing', 'read'), name: '', description: 'Reads' })).toEqual(
      {
        title: 'Get thing',
        path: 'get_thing',
        description: 'Reads',
      },
    );
  });

  test('the app prefix is dropped from the title, not from the id', () => {
    expect(
      toolRowText({ ...action('LINEAR_ARCHIVE_ISSUE', 'write'), name: 'LINEAR_ARCHIVE_ISSUE' }, [
        'linear',
      ]),
    ).toMatchObject({ title: 'Archive issue', path: 'LINEAR_ARCHIVE_ISSUE' });
  });
  test('no description at all', () => {
    expect(toolRowText(action('get_thing', 'read')).description).toBeNull();
  });
});

describe('humanizeToolName', () => {
  test.each([
    ['LINEAR_ARCHIVE_ISSUE', ['linear'], 'Archive issue'],
    ['ask_wiki_question', ['deepwiki'], 'Ask wiki question'],
    ['GMAIL_SEND_EMAIL', ['gmail', 'Gmail'], 'Send email'],
    ['GOOGLE_SHEETS_ADD_ROW', ['google-sheets'], 'Add row'],
    ['GOOGLESHEETS_ADD_ROW', ['Google Sheets'], 'Add row'],
    ['getPetById', [], 'Get pet by id'],
    ['messages.send', [], 'Messages send'],
    ['repos/create-issue', [], 'Repos create issue'],
  ])('%s reads %p', (name, apps, title) => {
    expect(humanizeToolName(name, apps)).toBe(title);
  });

  test('a name with a space is the connector wording and is kept', () => {
    expect(humanizeToolName('Deletes a pet.', ['petstore'])).toBe('Deletes a pet.');
  });

  test('a prefix is not dropped when it is the whole name', () => {
    expect(humanizeToolName('linear', ['linear'])).toBe('Linear');
    expect(humanizeToolName('LINEAR_SEARCH', ['linear'])).toBe('Search');
  });

  test('only a whole leading word matches the app', () => {
    expect(humanizeToolName('linearize_data', ['linear'])).toBe('Linearize data');
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

describe('toolBucket', () => {
  const unknown = (path: string) => ({ path, name: path, risk: 'unknown' });
  test('a declared risk wins over the name', () => {
    expect(toolBucket({ path: 'get_issue', name: 'get_issue', risk: 'write' })).toBe('write');
    expect(toolBucket({ path: 'send', name: 'send', risk: 'read' })).toBe('read');
  });
  test('an unknown risk goes by the name, without the app prefix', () => {
    expect(toolBucket(unknown('LINEAR_GET_ISSUE'), ['linear'])).toBe('read');
    expect(toolBucket(unknown('listIssues'))).toBe('read');
    expect(toolBucket(unknown('send_email'))).toBe('write');
    expect(toolBucket(unknown('ask_wiki_question'))).toBe('unclassified');
    expect(toolBucket(unknown('getaway'))).toBe('unclassified');
  });
  test("the server's likely_risk wins over the enforced risk", () => {
    expect(toolBucket({ path: 'read_wiki_contents', name: 'read_wiki_contents', risk: 'write', likely_risk: 'read' })).toBe('read');
    expect(toolBucket({ path: 'ask_wiki_question', name: 'ask_wiki_question', risk: 'write', likely_risk: 'unknown' })).toBe('unclassified');
  });
  test('groups come in read, write, unclassified order', () => {
    const groups = groupToolsByRisk(
      [
        { ...action('ask', 'read'), risk: 'unknown' as never },
        action('create_issue', 'write'),
        action('get_issue', 'read'),
      ],
      testUiTranslator,
    );
    expect(groups.map((g) => g.key)).toEqual(['read', 'write', 'unclassified']);
  });
});
