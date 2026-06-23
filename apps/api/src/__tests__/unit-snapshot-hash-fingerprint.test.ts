// Proves the mass-rebuild ROOT CAUSE that Phase 2 (agent-swap) targets: the
// runtime fingerprint — which currentRuntimeArtifactFingerprint() derives from
// apps/kortix-sandbox-agent-server/src — is folded into EVERY template's snapshot
// identity (computeSnapshotHash, runtime=...). So one agent-server change re-mints
// every template's name → provider cache miss → full rebuild of all of them.
// Pure + deterministic (no fs / network / env).
import { describe, expect, mock, test } from 'bun:test';

// hash.ts only pulls SANDBOX_VERSION from ../config (a heavy module that imports
// zod + validates env). We pass runtimeFingerprint explicitly in every case, so
// the real default is never used — stub config to keep this a pure unit test.
mock.module('../config', () => ({ SANDBOX_VERSION: 'test-sandbox-version' }));
const { computeSnapshotHash } = await import('../snapshots/hash');

describe('Snapshot hash — runtime fingerprint coupling (mass-rebuild root cause)', () => {
  const userImage = {
    dockerfile: 'FROM ubuntu:24.04\nRUN echo hi\n',
    contextTreeOid: 'abc123deadbeef',
    spec: { cpu: 2, memory: 4, disk: 20 },
  };

  test('an agent-server change (new runtime fingerprint) RE-MINTS the snapshot name', () => {
    const v1 = computeSnapshotHash({ ...userImage, runtimeFingerprint: 'kortix-agent-src:v1' });
    const v2 = computeSnapshotHash({ ...userImage, runtimeFingerprint: 'kortix-agent-src:v2' });
    // Same user image, ONLY the agent changed → different content hash → different
    // snapshot name → cache miss → rebuild. This is the O(all templates) blast
    // radius Phase 2's CAS agent-swap removes.
    expect(v2.contentHash).not.toBe(v1.contentHash);
    expect(v2.shortHash).not.toBe(v1.shortHash);
  });

  test('same inputs are deterministic — no spurious rebuild', () => {
    const a = computeSnapshotHash({ ...userImage, runtimeFingerprint: 'kortix-agent-src:v1' });
    const b = computeSnapshotHash({ ...userImage, runtimeFingerprint: 'kortix-agent-src:v1' });
    expect(a.contentHash).toBe(b.contentHash);
  });

  test('the blast radius is ALL templates: two DISTINCT user images both re-mint from one agent bump', () => {
    const imgA = { dockerfile: 'FROM ubuntu:24.04\n', contextTreeOid: 'oidA' };
    const imgB = { dockerfile: 'FROM python:3.12\n', contextTreeOid: 'oidB' };
    const a1 = computeSnapshotHash({ ...imgA, runtimeFingerprint: 'agent:v1' });
    const a2 = computeSnapshotHash({ ...imgA, runtimeFingerprint: 'agent:v2' });
    const b1 = computeSnapshotHash({ ...imgB, runtimeFingerprint: 'agent:v1' });
    const b2 = computeSnapshotHash({ ...imgB, runtimeFingerprint: 'agent:v2' });
    expect(a2.shortHash).not.toBe(a1.shortHash); // template A re-mints
    expect(b2.shortHash).not.toBe(b1.shortHash); // template B re-mints from the SAME bump
    expect(a1.shortHash).not.toBe(b1.shortHash); // user content still distinguishes them
  });

  test('a user-content change alone also re-mints (identity = user content + runtime)', () => {
    const fp = 'agent:v1';
    const h1 = computeSnapshotHash({ dockerfile: 'FROM ubuntu:24.04\n', contextTreeOid: 'oid', runtimeFingerprint: fp });
    const h2 = computeSnapshotHash({ dockerfile: 'FROM ubuntu:24.04\nRUN apt update\n', contextTreeOid: 'oid', runtimeFingerprint: fp });
    expect(h2.shortHash).not.toBe(h1.shortHash);
  });
});
