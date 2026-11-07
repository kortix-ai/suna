import { describe, expect, test } from 'bun:test';

import { NO_WORKSPACE_TEXT, workspaceRows } from './workspaces.ts';

describe('workspaceRows', () => {
  test('an account with no project is not a workspace', () => {
    const rows = workspaceRows(
      [{ account_id: 'a-empty' }, { account_id: 'a-1' }],
      new Map([
        ['a-empty', []],
        ['a-1', [{ project_id: 'p-1', account_id: 'a-1', name: 'Atlas' }]],
      ]),
    );
    expect(rows).toEqual([{ id: 'p-1', accountId: 'a-1', name: 'Atlas' }]);
  });

  test('a legacy account with several projects lists each one as its own workspace', () => {
    const rows = workspaceRows(
      [{ account_id: 'a-1' }, { account_id: 'a-2' }],
      new Map([
        [
          'a-1',
          [
            { project_id: 'p-1', account_id: 'a-1', name: 'Atlas' },
            { project_id: 'p-2', account_id: 'a-1', name: 'Borealis' },
          ],
        ],
        ['a-2', [{ project_id: 'p-3', account_id: 'a-2', name: 'Comet' }]],
      ]),
    );
    expect(rows.map((row) => [row.id, row.accountId, row.name])).toEqual([
      ['p-1', 'a-1', 'Atlas'],
      ['p-2', 'a-1', 'Borealis'],
      ['p-3', 'a-2', 'Comet'],
    ]);
  });

  test('no account → no workspace, and the empty text names the CLI command', () => {
    expect(workspaceRows([], new Map())).toEqual([]);
    expect(NO_WORKSPACE_TEXT).toBe(
      'No workspace yet. Create one with kortix workspaces create <name>, or accept an invite.',
    );
  });

  test('a project id seen twice is listed once, and a blank name falls back to the id', () => {
    const rows = workspaceRows(
      [{ account_id: 'a-1' }, { account_id: 'a-2' }],
      new Map([
        ['a-1', [{ project_id: 'p-12345678', account_id: 'a-1', name: '' }]],
        ['a-2', [{ project_id: 'p-12345678', account_id: 'a-1', name: '' }]],
      ]),
    );
    expect(rows).toEqual([{ id: 'p-12345678', accountId: 'a-1', name: 'p-123456' }]);
  });
});
