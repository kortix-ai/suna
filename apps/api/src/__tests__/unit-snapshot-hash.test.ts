import { describe, expect, test } from 'bun:test';
import {
  computeSnapshotHash,
  currentRuntimeFingerprint,
  formatSnapshotName,
} from '../snapshots/hash';

const SAMPLE_DOCKERFILE = 'FROM ubuntu:24.04\nRUN apt-get install -y curl\n';
const SAMPLE_TREE_OID = '1234567890abcdef1234567890abcdef12345678';
const PINNED_FINGERPRINT = 'kortix-runtime:test-pin';

describe('computeSnapshotHash', () => {
  test('is deterministic across calls with identical inputs', () => {
    const a = computeSnapshotHash({
      dockerfile: SAMPLE_DOCKERFILE,
      contextTreeOid: SAMPLE_TREE_OID,
      runtimeFingerprint: PINNED_FINGERPRINT,
    });
    const b = computeSnapshotHash({
      dockerfile: SAMPLE_DOCKERFILE,
      contextTreeOid: SAMPLE_TREE_OID,
      runtimeFingerprint: PINNED_FINGERPRINT,
    });
    expect(a.contentHash).toBe(b.contentHash);
    expect(a.shortHash).toBe(b.shortHash);
    expect(a.contentHash).toHaveLength(64);
    expect(a.shortHash).toHaveLength(12);
  });

  test('Dockerfile change invalidates the hash', () => {
    const a = computeSnapshotHash({
      dockerfile: SAMPLE_DOCKERFILE,
      contextTreeOid: SAMPLE_TREE_OID,
      runtimeFingerprint: PINNED_FINGERPRINT,
    });
    const b = computeSnapshotHash({
      dockerfile: SAMPLE_DOCKERFILE + 'RUN echo "extra"\n',
      contextTreeOid: SAMPLE_TREE_OID,
      runtimeFingerprint: PINNED_FINGERPRINT,
    });
    expect(a.contentHash).not.toBe(b.contentHash);
  });

  test('context tree OID change invalidates the hash', () => {
    const a = computeSnapshotHash({
      dockerfile: SAMPLE_DOCKERFILE,
      contextTreeOid: SAMPLE_TREE_OID,
      runtimeFingerprint: PINNED_FINGERPRINT,
    });
    const b = computeSnapshotHash({
      dockerfile: SAMPLE_DOCKERFILE,
      contextTreeOid: 'fedcba0987654321fedcba0987654321fedcba09',
      runtimeFingerprint: PINNED_FINGERPRINT,
    });
    expect(a.contentHash).not.toBe(b.contentHash);
  });

  test('runtime fingerprint change invalidates the hash', () => {
    const a = computeSnapshotHash({
      dockerfile: SAMPLE_DOCKERFILE,
      contextTreeOid: SAMPLE_TREE_OID,
      runtimeFingerprint: 'kortix-runtime:v1',
    });
    const b = computeSnapshotHash({
      dockerfile: SAMPLE_DOCKERFILE,
      contextTreeOid: SAMPLE_TREE_OID,
      runtimeFingerprint: 'kortix-runtime:v2',
    });
    expect(a.contentHash).not.toBe(b.contentHash);
  });

  test('length-prefixing prevents adjacent-field collisions', () => {
    // "ab" + "cd" must not collide with "a" + "bcd" — the length prefix
    // makes the concatenation unambiguous.
    const a = computeSnapshotHash({
      dockerfile: 'ab',
      contextTreeOid: 'cd',
      runtimeFingerprint: PINNED_FINGERPRINT,
    });
    const b = computeSnapshotHash({
      dockerfile: 'a',
      contextTreeOid: 'bcd',
      runtimeFingerprint: PINNED_FINGERPRINT,
    });
    expect(a.contentHash).not.toBe(b.contentHash);
  });

  test('runtimeFingerprint defaults to currentRuntimeFingerprint()', () => {
    const a = computeSnapshotHash({
      dockerfile: SAMPLE_DOCKERFILE,
      contextTreeOid: SAMPLE_TREE_OID,
    });
    expect(a.runtimeFingerprint).toBe(currentRuntimeFingerprint());
  });

  test('an empty / absent spec does not change the hash (no mass rebuild)', () => {
    const base = computeSnapshotHash({
      dockerfile: SAMPLE_DOCKERFILE,
      contextTreeOid: SAMPLE_TREE_OID,
      runtimeFingerprint: PINNED_FINGERPRINT,
    });
    const withEmpty = computeSnapshotHash({
      dockerfile: SAMPLE_DOCKERFILE,
      contextTreeOid: SAMPLE_TREE_OID,
      spec: {},
      runtimeFingerprint: PINNED_FINGERPRINT,
    });
    expect(withEmpty.contentHash).toBe(base.contentHash);
  });

  test('declaring a spec invalidates the hash', () => {
    const base = computeSnapshotHash({
      dockerfile: SAMPLE_DOCKERFILE,
      contextTreeOid: SAMPLE_TREE_OID,
      runtimeFingerprint: PINNED_FINGERPRINT,
    });
    const withSpec = computeSnapshotHash({
      dockerfile: SAMPLE_DOCKERFILE,
      contextTreeOid: SAMPLE_TREE_OID,
      spec: { cpu: 4, memory: 8 },
      runtimeFingerprint: PINNED_FINGERPRINT,
    });
    expect(withSpec.contentHash).not.toBe(base.contentHash);
  });

  test('changing any spec field invalidates the hash', () => {
    const a = computeSnapshotHash({
      dockerfile: SAMPLE_DOCKERFILE,
      contextTreeOid: SAMPLE_TREE_OID,
      spec: { cpu: 2, memory: 4, disk: 20 },
      runtimeFingerprint: PINNED_FINGERPRINT,
    });
    const b = computeSnapshotHash({
      dockerfile: SAMPLE_DOCKERFILE,
      contextTreeOid: SAMPLE_TREE_OID,
      spec: { cpu: 2, memory: 4, disk: 40 },
      runtimeFingerprint: PINNED_FINGERPRINT,
    });
    expect(a.contentHash).not.toBe(b.contentHash);
  });

  test('spec serialization is order-independent (same fields → same hash)', () => {
    const a = computeSnapshotHash({
      dockerfile: SAMPLE_DOCKERFILE,
      contextTreeOid: SAMPLE_TREE_OID,
      spec: { cpu: 2, memory: 4 },
      runtimeFingerprint: PINNED_FINGERPRINT,
    });
    const b = computeSnapshotHash({
      dockerfile: SAMPLE_DOCKERFILE,
      contextTreeOid: SAMPLE_TREE_OID,
      spec: { memory: 4, cpu: 2 },
      runtimeFingerprint: PINNED_FINGERPRINT,
    });
    expect(a.contentHash).toBe(b.contentHash);
  });
});

describe('formatSnapshotName', () => {
  test('is a pure content-hash name (no project tier)', () => {
    const projectId = '12345678-90ab-cdef-1234-567890abcdef';
    const name = formatSnapshotName(projectId, 'a'.repeat(64));
    expect(name).toBe('kortix-snap-aaaaaaaaaaaa');
  });

  test('two distinct projects with identical content COLLAPSE to one name (starter sharing)', () => {
    const hash = 'b'.repeat(64);
    const a = formatSnapshotName('11111111-1111-1111-1111-111111111111', hash);
    const b = formatSnapshotName('22222222-2222-2222-2222-222222222222', hash);
    expect(a).toBe(b);
  });

  test('two commits in the same project with identical content collapse to one name', () => {
    const projectId = '99999999-9999-9999-9999-999999999999';
    const hash = computeSnapshotHash({
      dockerfile: SAMPLE_DOCKERFILE,
      contextTreeOid: SAMPLE_TREE_OID,
      runtimeFingerprint: PINNED_FINGERPRINT,
    }).contentHash;
    const a = formatSnapshotName(projectId, hash);
    const b = formatSnapshotName(projectId, hash);
    expect(a).toBe(b);
  });
});
