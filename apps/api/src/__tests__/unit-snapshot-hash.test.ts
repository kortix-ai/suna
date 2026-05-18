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
});

describe('formatSnapshotName', () => {
  test('embeds project + content hash, strips dashes from project id', () => {
    const projectId = '12345678-90ab-cdef-1234-567890abcdef';
    const name = formatSnapshotName(projectId, 'a'.repeat(64));
    expect(name).toBe('kortix-snap-12345678-aaaaaaaaaaaa');
  });

  test('two distinct projects with identical content get distinct names', () => {
    const hash = 'b'.repeat(64);
    const a = formatSnapshotName('11111111-1111-1111-1111-111111111111', hash);
    const b = formatSnapshotName('22222222-2222-2222-2222-222222222222', hash);
    expect(a).not.toBe(b);
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
