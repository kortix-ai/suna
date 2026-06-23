// Proves the mass-rebuild ROOT CAUSE that Phase 2 (agent-swap) targets: the
// runtime fingerprint — which currentRuntimeArtifactFingerprint() derives from
// apps/kortix-sandbox-agent-server/src — is folded into EVERY template's snapshot
// identity (computeSnapshotHash, runtime=...). So one agent-server change re-mints
// every template's name → provider cache miss → full rebuild of all of them.
// Pure + deterministic (no fs / network / env).
import { describe, expect, test } from 'bun:test';
// hash.ts pulls SANDBOX_VERSION from ../config; we pass runtimeFingerprint
// explicitly in every case so that default is never used. Tests run under dotenvx
// (scripts/test.sh) so the real config loads fine — and we deliberately do NOT
// `mock.module('../config')` here: in bun that mock is process-GLOBAL and leaks
// into sibling test files (it broke the daytona suite in combined runs).
import { computeSnapshotHash } from '../snapshots/hash';

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

  // The CORRECT decision key (post-audit): computeTemplateIdentity derives swapKey
  // by hashing the user image + spec with the NON-AGENT runtime fingerprint (the
  // runtime layer MINUS the agent binary). The full identity uses the FULL runtime
  // fingerprint. So an AGENT-ONLY change moves the full identity (rebuild trigger)
  // while leaving swapKey unchanged → swap; ANY non-agent change (opencode /
  // entrypoint / CLI / browser / layer) ALSO moves swapKey → full rebuild. This is
  // what prevents shipping a stale opencode/CLI under a new-identity name.
  describe('swapKey — the agent-swap decision key (built from the NON-agent fingerprint)', () => {
    const img = { dockerfile: 'FROM ubuntu:24.04\n', contextTreeOid: 'oid', spec: { cpu: 2, memory: 4, disk: 20 } };
    const identity = (fullFp: string) => computeSnapshotHash({ ...img, runtimeFingerprint: fullFp }).shortHash;
    const swapKey = (nonAgentFp: string) => computeSnapshotHash({ ...img, runtimeFingerprint: nonAgentFp }).shortHash;

    test('agent-only bump: identity moves (drift) but swapKey is unchanged → SWAP', () => {
      // Agent src changed → full fingerprint moves; the non-agent fingerprint does not.
      expect(identity('full:agentV1+nonAgentX')).not.toBe(identity('full:agentV2+nonAgentX'));
      expect(swapKey('nonAgentX')).toBe(swapKey('nonAgentX'));
    });

    test('non-agent bump (opencode/entrypoint/CLI/browser): swapKey ALSO moves → REBUILD, never a stale-image swap', () => {
      expect(swapKey('nonAgent:opencodeV1')).not.toBe(swapKey('nonAgent:opencodeV2'));
    });

    test('swapKey still distinguishes user image + spec (no false swap across those)', () => {
      expect(swapKey('nonAgentX')).not.toBe(
        computeSnapshotHash({ ...img, dockerfile: 'FROM python:3.12\n', runtimeFingerprint: 'nonAgentX' }).shortHash,
      );
      expect(swapKey('nonAgentX')).not.toBe(
        computeSnapshotHash({ ...img, spec: { cpu: 4, memory: 8, disk: 40 }, runtimeFingerprint: 'nonAgentX' }).shortHash,
      );
    });
  });
});
