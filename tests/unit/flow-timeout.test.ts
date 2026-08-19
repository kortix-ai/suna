import { describe, expect, it } from 'vitest';
import { DEFAULT_FLOW_TIMEOUT_MS, resolveFlowTimeoutMs } from '../src/core/flow';

describe('per-flow wall-clock budget', () => {
  it('keeps the 120s local default when nothing is configured', () => {
    expect(DEFAULT_FLOW_TIMEOUT_MS).toBe(120_000);
    expect(resolveFlowTimeoutMs(undefined, {})).toBe(120_000);
  });

  it('keeps a flow-declared budget untouched when the env knob is unset', () => {
    expect(resolveFlowTimeoutMs(300_000, {})).toBe(300_000);
    expect(resolveFlowTimeoutMs(60_000, {})).toBe(60_000);
    expect(resolveFlowTimeoutMs(60_000, { KE2E_FLOW_TIMEOUT_MS: '' })).toBe(60_000);
  });

  it('raises the default for a deployed target', () => {
    // Run 32231251280: ~50% of flows failed `exceeded 120000ms` on live staging.
    expect(resolveFlowTimeoutMs(undefined, { KE2E_FLOW_TIMEOUT_MS: '180000' })).toBe(180_000);
  });

  it('treats the env budget as a floor, never a cap', () => {
    // A `kortix ship` flow declares 20 minutes because it needs 20 minutes.
    expect(resolveFlowTimeoutMs(1_200_000, { KE2E_FLOW_TIMEOUT_MS: '180000' })).toBe(1_200_000);
    // A budget tuned for the local stack does not survive a deployed target.
    expect(resolveFlowTimeoutMs(60_000, { KE2E_FLOW_TIMEOUT_MS: '180000' })).toBe(180_000);
  });

  it('ignores a non-numeric or non-positive budget instead of disabling the timeout', () => {
    expect(resolveFlowTimeoutMs(undefined, { KE2E_FLOW_TIMEOUT_MS: 'soon' })).toBe(120_000);
    expect(resolveFlowTimeoutMs(undefined, { KE2E_FLOW_TIMEOUT_MS: '0' })).toBe(120_000);
    expect(resolveFlowTimeoutMs(60_000, { KE2E_FLOW_TIMEOUT_MS: '0' })).toBe(60_000);
    expect(resolveFlowTimeoutMs(300_000, { KE2E_FLOW_TIMEOUT_MS: 'soon' })).toBe(300_000);
  });
});
