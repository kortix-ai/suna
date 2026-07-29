import { describe, expect, test } from 'bun:test';

import { parseExecutorCallInput } from '../commands/executor';

describe('kortix executor call input', () => {
  test('accepts the dotted tool reference returned by discovery', () => {
    expect(parseExecutorCallInput(['google_drive.list_files', '{"pageSize":10}'], {})).toEqual({
      slug: 'google_drive',
      action: 'list_files',
      rawArgs: '{"pageSize":10}',
    });
  });

  test('splits only the first dot so nested action paths remain intact', () => {
    expect(parseExecutorCallInput(['internal_graph.query.user', '{"id":"1"}'], {})).toEqual({
      slug: 'internal_graph',
      action: 'query.user',
      rawArgs: '{"id":"1"}',
    });
  });

  test('keeps the existing split form compatible', () => {
    expect(parseExecutorCallInput(['google_drive', 'list_files', '{"pageSize":10}'], {})).toEqual({
      slug: 'google_drive',
      action: 'list_files',
      rawArgs: '{"pageSize":10}',
    });
  });

  test('rejects an agent override because session identity is token-bound', () => {
    expect(() => parseExecutorCallInput(['google_drive.list_files', '{}'], { as: 'mike' })).toThrow(
      '`--as` is not supported. Executor identity is fixed by the session token. Start a new session to use another agent.',
    );
  });
});
