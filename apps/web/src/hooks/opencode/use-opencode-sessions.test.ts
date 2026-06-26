import { describe, expect, test } from 'bun:test';

import { canQueryOpenCodeSession } from './use-opencode-sessions';

describe('OpenCode session id boundaries', () => {
  test('does not query OpenCode session endpoints with project session UUIDs', () => {
    expect(canQueryOpenCodeSession('9f4a8825-b907-46e4-bd05-2369b6bb5fa1')).toBe(false);
    expect(canQueryOpenCodeSession('ses_0fd244845ffepxcTP43qmfL5Mw')).toBe(true);
  });
});
