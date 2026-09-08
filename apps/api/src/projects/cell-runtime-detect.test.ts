// WHETHER A SANDBOX ROW SAYS "CELL" — and the case that made the first fix a no-op.
//
// On a shared cell host the control plane must NOT discover a session's root by
// listing `GET /session`: that request carries no session, so it lands on the
// worker's default cell and later sessions adopt the first one's root. Measured
// on dev 2026-09-08 with the flag on, an adopted session logged
// `runtime: null -> cellPin: null` and inherited 3ab0bd9d, the first session's id.
import { describe, expect, test } from 'bun:test';
import { cellRuntimeFromSandboxMetadata } from './cell-runtime-detect';

describe('reading the runtime off a sandbox row', () => {
  test('an ADOPTED session is a cell — the case the first fix missed', () => {
    // The pooled-claim path replaces the metadata with its own, so
    // `pi_worker_boot` is gone and only the artifact remains. These are exactly
    // the sessions that share a box.
    expect(cellRuntimeFromSandboxMetadata({
      provisionedBy: 'u1', daytonaSandboxId: 'sbx_1', pooled: true,
      runtimeArtifact: { sandboxSlug: 'pi-worker', runtimeProfile: 'pi-worker' },
    })).toBe('cell');
  });

  test('a cold pi create is a cell, by the flag its own path sets', () => {
    expect(cellRuntimeFromSandboxMetadata({ pi_worker_boot: true })).toBe('cell');
    // Some writers land it as text through jsonb.
    expect(cellRuntimeFromSandboxMetadata({ pi_worker_boot: 'true' })).toBe('cell');
  });

  test('and the explicit marker wins wherever it appears', () => {
    expect(cellRuntimeFromSandboxMetadata({ 'kortix.runtime': 'cell' })).toBe('cell');
    expect(cellRuntimeFromSandboxMetadata({ 'kortix.runtime': 'CELL' })).toBe('cell');
  });

  test('an ordinary box is NOT a cell, so it still discovers its root', () => {
    // OpenCode owns its own session ids; pinning by construction would be wrong.
    expect(cellRuntimeFromSandboxMetadata({ provisionedBy: 'u1', pooled: true })).toBeNull();
    expect(cellRuntimeFromSandboxMetadata({ 'kortix.runtime': 'microvm' })).toBeNull();
    expect(cellRuntimeFromSandboxMetadata({ pi_worker_boot: false })).toBeNull();
    expect(cellRuntimeFromSandboxMetadata({ runtimeArtifact: { sandboxSlug: 'default' } })).toBeNull();
  });

  test('junk is not a cell', () => {
    expect(cellRuntimeFromSandboxMetadata(null)).toBeNull();
    expect(cellRuntimeFromSandboxMetadata(undefined)).toBeNull();
    expect(cellRuntimeFromSandboxMetadata('cell')).toBeNull();
    expect(cellRuntimeFromSandboxMetadata([{ pi_worker_boot: true }])).toBeNull();
    expect(cellRuntimeFromSandboxMetadata({ runtimeArtifact: 'pi-worker' })).toBeNull();
  });
});
