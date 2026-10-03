import { describe, expect, test } from 'bun:test';
import { getDiagnosticFields, runWithContext } from '../../lib/request-context';
import { timeConfigStage } from './config-stage-timing';

describe('config stage timing', () => {
  test('records both concurrent pending calls at a deadline and clears them on completion', async () => {
    await runWithContext('GET', '/config', async () => {
      let release!: () => void;
      const waiting = new Promise<void>((resolve) => { release = resolve; });
      const first = timeConfigStage('sandbox_state', () => waiting);
      const second = timeConfigStage('latest_etag', () => waiting);
      expect(getDiagnosticFields().config_pending_stages).toBe('sandbox_state,latest_etag');
      release();
      await Promise.all([first, second]);
      expect(getDiagnosticFields().config_pending_stages).toBe('');
      expect(Number(getDiagnosticFields().config_sandbox_state_ms)).toBeGreaterThanOrEqual(0);
      expect(Number(getDiagnosticFields().config_latest_etag_ms)).toBeGreaterThanOrEqual(0);
    });
  });
  test('records the stage even when the awaited call rejects', async () => {
    await runWithContext('GET', '/config', async () => {
      await expect(timeConfigStage('runtime_block', async () => { throw new Error('synthetic'); })).rejects.toThrow('synthetic');
      expect(getDiagnosticFields().config_pending_stages).toBe('');
      expect(getDiagnosticFields().config_runtime_block_ms).toBeDefined();
    });
  });
});
