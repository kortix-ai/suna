/**
 * `sealFlowState`/`openFlowState` — the opaque, project-key-encrypted device-
 * flow handle (spec §3.1/§6.3). The security property under test: a handle is
 * only openable by the SAME project that sealed it, and any tampered/foreign/
 * garbage input opens to `null` (never a throw), so a poll can never be forged
 * or replayed cross-project.
 *
 * The real envelope is AES-256-GCM keyed by a per-project HKDF derivation that
 * needs `API_KEY_SECRET` (env-blocked in bare `bun test` runs). This mock is a
 * deterministic, reversible stand-in that binds `projectId` into the
 * ciphertext exactly as the real per-project key does — so the cross-project
 * isolation assertion is meaningful, not mocked away.
 */
import { afterAll, describe, expect, mock, test } from 'bun:test';

mock.module('../../../projects/secrets', () => ({
  encryptProjectSecret: (projectId: string, value: string) =>
    `enc:${projectId}:${Buffer.from(value).toString('base64')}`,
  decryptProjectSecret: (projectId: string, enc: string) => {
    const [tag, pid, b64] = enc.split(':');
    if (tag !== 'enc' || pid !== projectId || b64 === undefined) {
      throw new Error('cannot decrypt (wrong project or tampered)');
    }
    const decoded = Buffer.from(b64, 'base64');
    // Integrity check standing in for AES-GCM's auth tag: a tampered/appended
    // ciphertext no longer canonically re-encodes to the stored segment.
    if (decoded.toString('base64') !== b64) {
      throw new Error('cannot decrypt (integrity check failed)');
    }
    return decoded.toString();
  },
}));

const { openFlowState, sealFlowState } = await import('./flow-state');

afterAll(() => mock.restore());

interface State {
  d: string;
  u: string;
  e: number;
}

describe('sealFlowState / openFlowState', () => {
  test('round-trips arbitrary flow state', () => {
    const state: State = { d: 'device-1', u: 'WXYZ-1234', e: 1_700_000_000_000 };
    const handle = sealFlowState('proj-a', state);
    expect(openFlowState<State>('proj-a', handle)).toEqual(state);
  });

  test('a handle sealed for one project does not open under another → null', () => {
    const handle = sealFlowState('proj-a', { d: 'x', u: 'y', e: 1 });
    expect(openFlowState<State>('proj-b', handle)).toBeNull();
  });

  test('a tampered handle opens to null, never throws', () => {
    const handle = sealFlowState('proj-a', { d: 'x', u: 'y', e: 1 });
    expect(openFlowState<State>('proj-a', `${handle}TAMPER`)).toBeNull();
  });

  test('garbage input opens to null', () => {
    expect(openFlowState<State>('proj-a', 'not-a-handle')).toBeNull();
    expect(openFlowState<State>('proj-a', '')).toBeNull();
  });
});
