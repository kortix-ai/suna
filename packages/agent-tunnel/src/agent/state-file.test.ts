import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readAgentState, stateFilePath, writeAgentState } from './state-file';

describe('agent state file', () => {
  test('writes the status atomically, privately, and reads it back', () => {
    const home = join(mkdtempSync(join(tmpdir(), 'agent-tunnel-state-')), 'home');
    try {
      expect(readAgentState(home)).toBeNull();
      const tunnel = { tunnelId: '00000000-0000-4000-8000-000000000001', apiUrl: 'http://127.0.0.1:8008/v1/tunnel' };

      writeAgentState('connecting', tunnel, home);
      writeAgentState('online', tunnel, home);

      const state = readAgentState(home);
      expect(state).toMatchObject({ ...tunnel, status: 'online', pid: process.pid });
      expect(Date.parse(state!.since)).toBeGreaterThan(Date.now() - 5_000);
      expect(typeof state!.agentVersion).toBe('string');
      expect(statSync(stateFilePath(home)).mode & 0o077).toBe(0);
      expect(statSync(home).mode & 0o077).toBe(0);
      // No temp file is left behind.
      expect(readdirSync(home)).toEqual(['state.json']);
      // The state never carries the credential.
      expect(JSON.stringify(state)).not.toContain('token');
    } finally {
      rmSync(join(home, '..'), { recursive: true, force: true });
    }
  });
});
