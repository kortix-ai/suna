import { describe, expect, test } from 'bun:test';

import { parseConnectorCallInput } from '../commands/connector-gateway';
import { parseExecArgs } from '../connector-gateway/io';

describe('kortix connectors call input', () => {
  test('accepts the dotted tool reference returned by discovery', () => {
    expect(parseConnectorCallInput(['google_drive.list_files', '{"pageSize":10}'], {})).toEqual({
      slug: 'google_drive',
      action: 'list_files',
      rawArgs: '{"pageSize":10}',
    });
  });

  test('splits only the first dot so nested action paths remain intact', () => {
    expect(parseConnectorCallInput(['internal_graph.query.user', '{"id":"1"}'], {})).toEqual({
      slug: 'internal_graph',
      action: 'query.user',
      rawArgs: '{"id":"1"}',
    });
  });

  test('keeps the existing split form compatible', () => {
    expect(parseConnectorCallInput(['google_drive', 'list_files', '{"pageSize":10}'], {})).toEqual({
      slug: 'google_drive',
      action: 'list_files',
      rawArgs: '{"pageSize":10}',
    });
  });

  test('rejects an agent override because session identity is token-bound', () => {
    expect(() =>
      parseConnectorCallInput(['google_drive.list_files', '{}'], { as: 'mike' }),
    ).toThrow(
      '`--as` is not supported. Connector identity is fixed by the session token. Start a new session to use another agent.',
    );
  });
});

describe('parseExecArgs flag values', () => {
  test('a valueless flag is the boolean true, a valued one is its string', () => {
    const { args, flags, repeated } = parseExecArgs([
      'call',
      'crm.whoami',
      '--account',
      '--project',
      'proj-1',
    ]);
    expect(args).toEqual(['crm.whoami']);
    expect(flags.account).toBe(true);
    expect(flags.project).toBe('proj-1');
    expect(repeated.account).toEqual([true]);
  });
});
