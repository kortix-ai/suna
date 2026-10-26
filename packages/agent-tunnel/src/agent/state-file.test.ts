import { describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

  test('a writer that died without writing offline reads as offline', () => {
    const home = mkdtempSync(join(tmpdir(), 'agent-tunnel-state-'));
    try {
      writeFileSync(stateFilePath(home), JSON.stringify({ tunnelId: 't', apiUrl: 'u', status: 'online', since: '', agentVersion: '0', pid: 2 ** 22 + 7 }));
      expect(readAgentState(home)?.status).toBe('offline');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('state PID liveness', () => {
  test.each([null, '1', 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid PID %p without probing', (pid) => {
    const home = mkdtempSync(join(tmpdir(), 'agent-tunnel-state-'));
    writeFileSync(stateFilePath(home), JSON.stringify({ status: 'online', pid }));
    const kill = spyOn(process, 'kill');
    try {
      expect(readAgentState(home)?.status).toBe('offline');
      expect(kill).not.toHaveBeenCalled();
    } finally { kill.mockRestore(); rmSync(home, { recursive: true, force: true }); }
  });

  test.each(['live', 'ESRCH', 'EPERM'])('handles %s', (result) => {
    const home = mkdtempSync(join(tmpdir(), 'agent-tunnel-state-'));
    writeFileSync(stateFilePath(home), JSON.stringify({ status: 'online', pid: process.pid }));
    const kill = spyOn(process, 'kill').mockImplementation(() => {
      if (result !== 'live') throw Object.assign(new Error(result), { code: result });
      return true;
    });
    try {
      expect(readAgentState(home)?.status).toBe(result === 'ESRCH' ? 'offline' : 'online');
      expect(kill).toHaveBeenCalledWith(process.pid, 0);
    } finally { kill.mockRestore(); rmSync(home, { recursive: true, force: true }); }
  });
});
