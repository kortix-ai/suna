import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const filesSource = readFileSync(
  join(import.meta.dir, '../files/sandbox-file-explorer.tsx'),
  'utf8',
);
const terminalSource = readFileSync(join(import.meta.dir, 'session-terminal-panel.tsx'), 'utf8');

describe('runtime tool recovery', () => {
  test('Files replaces a prolonged health skeleton with its retry state', () => {
    expect(filesSource).toContain('useBoundedRuntimeWait(isHealthLoading, retryAttempt)');
    expect(filesSource).toContain('isHealthLoading && !healthWaitExpired');
    expect(filesSource).toContain('!health?.healthy || healthWaitExpired');
  });

  test('Terminal bounds readiness waits and re-arms the deadline on retry', () => {
    expect(terminalSource).toContain('const terminalWaitExpired = useBoundedRuntimeWait(');
    expect(terminalSource).toContain('connectionWaitExpired: terminalWaitExpired');
    expect(terminalSource).toContain('setServerRetryAttempt((attempt) => attempt + 1)');
  });
});
