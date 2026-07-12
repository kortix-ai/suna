import { describe, expect, test } from 'bun:test';

import { canQueryRuntimeSession } from './use-runtime-sessions';

describe('Runtime session id boundaries', () => {
  test('does not query Runtime session endpoints with project session UUIDs', () => {
    expect(canQueryRuntimeSession('9f4a8825-b907-46e4-bd05-2369b6bb5fa1')).toBe(false);
    expect(canQueryRuntimeSession('ses_0fd244845ffepxcTP43qmfL5Mw')).toBe(true);
  });
});
