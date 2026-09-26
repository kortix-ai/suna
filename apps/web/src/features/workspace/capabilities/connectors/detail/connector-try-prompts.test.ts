import type { ConnectorAction } from '@kortix/sdk';
import { describe, expect, test } from 'bun:test';

import { connectorTryPrompts, imperativeFromDescription } from './connector-try-prompts';

const action = (over: Partial<ConnectorAction>): ConnectorAction =>
  ({
    path: 'get_file',
    name: 'get_file',
    description: '',
    risk: 'read',
    ...over,
  }) as ConnectorAction;

describe('imperativeFromDescription', () => {
  test('turns a third-person tool description into an instruction', () => {
    expect(imperativeFromDescription('Lists the comments on a file.')).toBe(
      'List the comments on a file',
    );
    expect(imperativeFromDescription('Retrieves a user by id')).toBe('Retrieve a user by id');
    expect(imperativeFromDescription('Searches issues in a project')).toBe(
      'Search issues in a project',
    );
    expect(imperativeFromDescription('Fetches the latest release')).toBe(
      'Fetch the latest release',
    );
    expect(imperativeFromDescription('Gets the file JSON')).toBe('Get the file JSON');
  });

  test('keeps only the first sentence', () => {
    expect(imperativeFromDescription('Lists teams. Requires an admin token.')).toBe('List teams');
  });

  test('refuses descriptions that do not open with a third-person verb', () => {
    expect(imperativeFromDescription('Get a file')).toBeNull();
    expect(imperativeFromDescription('The file endpoint')).toBeNull();
    expect(imperativeFromDescription('Access to the address book')).toBeNull();
    expect(imperativeFromDescription('')).toBeNull();
  });

  test('refuses a sentence too long to read as a prompt', () => {
    expect(imperativeFromDescription(`Lists ${'very '.repeat(30)}many things`)).toBeNull();
  });
});

describe('connectorTryPrompts', () => {
  test('uses read tools only — a sample prompt must never change data', () => {
    const prompts = connectorTryPrompts([
      action({ path: 'delete_node', description: 'Deletes a node', risk: 'destructive' }),
      action({ path: 'post_comment', description: 'Posts a comment', risk: 'write' }),
      action({ path: 'get_comments', description: 'Lists the comments on a file' }),
    ]);
    expect(prompts).toEqual([{ path: 'get_comments', text: 'List the comments on a file' }]);
  });

  test('caps at three and drops duplicate sentences', () => {
    const prompts = connectorTryPrompts([
      action({ path: 'a', description: 'Lists files' }),
      action({ path: 'b', description: 'Lists files' }),
      action({ path: 'c', description: 'Gets a file' }),
      action({ path: 'd', description: 'Retrieves a team' }),
      action({ path: 'e', description: 'Returns a project' }),
    ]);
    expect(prompts.map((prompt) => prompt.path)).toEqual(['a', 'c', 'd']);
  });

  test('returns nothing when no read tool describes itself usably', () => {
    expect(connectorTryPrompts([action({ description: 'file endpoint' })])).toEqual([]);
  });
});
