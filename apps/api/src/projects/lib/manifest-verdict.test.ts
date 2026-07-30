import { describe, expect, test } from 'bun:test';

import {
  LATEST_MANIFEST_VERSION,
  resolveManifestVerdict,
  restrictedManifestVerdict,
} from './manifest-verdict';

const V3_YAML = `kortix_version: 3
default_agent: opencode
runtimes:
  opencode:
    harness: opencode
agents:
  opencode: {}
`;

const V2_YAML = `kortix_version: 2
default_agent: dev
agents:
  dev: {}
`;

const V1_TOML = `kortix_version = 1

[project]
name = "acme-ops"

[[agents]]
name = "dev"
`;

describe('LATEST_MANIFEST_VERSION', () => {
  test('is 3 — the highest manifest schema this platform ships', () => {
    expect(LATEST_MANIFEST_VERSION).toBe(3);
  });
});

describe('resolveManifestVerdict — a v3 manifest is up to date', () => {
  test('reports version 3 and offers no migration', () => {
    const verdict = resolveManifestVerdict({
      raw: V3_YAML,
      format: 'yaml',
      path: 'kortix.yaml',
    });
    expect(verdict.version).toBe(3);
    expect(verdict.migration_offered).toBe(false);
    expect(verdict.target_version).toBeNull();
    expect(verdict.unknown_reason).toBeNull();
    expect(verdict.path).toBe('kortix.yaml');
  });

  test('a version above the latest this platform knows still offers no migration', () => {
    const verdict = resolveManifestVerdict({
      raw: 'kortix_version: 9\n',
      format: 'yaml',
      path: 'kortix.yaml',
    });
    expect(verdict.version).toBe(9);
    expect(verdict.migration_offered).toBe(false);
    expect(verdict.target_version).toBeNull();
  });
});

describe('resolveManifestVerdict — a real v1 kortix.toml is offered a migration', () => {
  test('reports version 1 and targets the version the migration actually produces', () => {
    const verdict = resolveManifestVerdict({
      raw: V1_TOML,
      format: 'toml',
      path: 'kortix.toml',
    });
    expect(verdict.version).toBe(1);
    expect(verdict.migration_offered).toBe(true);
    expect(verdict.target_version).toBe(2);
    expect(verdict.unknown_reason).toBeNull();
    expect(verdict.path).toBe('kortix.toml');
  });

  test('a quoted string version still reads as v1', () => {
    const verdict = resolveManifestVerdict({
      raw: 'kortix_version: "1"\n',
      format: 'yaml',
      path: 'kortix.yaml',
    });
    expect(verdict.version).toBe(1);
    expect(verdict.migration_offered).toBe(true);
    expect(verdict.target_version).toBe(2);
  });
});

describe('resolveManifestVerdict — v2 has no implemented upgrade path', () => {
  test('reports version 2 below the latest, but offers nothing', () => {
    const verdict = resolveManifestVerdict({
      raw: V2_YAML,
      format: 'yaml',
      path: 'kortix.yaml',
    });
    expect(verdict.version).toBe(2);
    expect(verdict.latest_version).toBe(3);
    expect(verdict.migration_offered).toBe(false);
    expect(verdict.target_version).toBeNull();
  });
});

describe('resolveManifestVerdict — unknown never becomes "needs migrating"', () => {
  test('an absent manifest is unreadable, not v1', () => {
    for (const raw of [null, undefined, '', '   \n']) {
      const verdict = resolveManifestVerdict({ raw, format: 'yaml', path: null });
      expect(verdict.version).toBeNull();
      expect(verdict.unknown_reason).toBe('unreadable');
      expect(verdict.migration_offered).toBe(false);
      expect(verdict.target_version).toBeNull();
    }
  });

  test('an unparseable manifest is unparsable, not v1', () => {
    const verdict = resolveManifestVerdict({
      raw: 'kortix_version = = 1\n[[[broken',
      format: 'toml',
      path: 'kortix.toml',
    });
    expect(verdict.version).toBeNull();
    expect(verdict.unknown_reason).toBe('unparsable');
    expect(verdict.migration_offered).toBe(false);
  });

  test('a manifest that parses but declares no kortix_version is undeclared, not v1', () => {
    const verdict = resolveManifestVerdict({
      raw: 'project:\n  name: acme\n',
      format: 'yaml',
      path: 'kortix.yaml',
    });
    expect(verdict.version).toBeNull();
    expect(verdict.unknown_reason).toBe('undeclared');
    expect(verdict.migration_offered).toBe(false);
    expect(verdict.target_version).toBeNull();
  });

  test('a non-numeric kortix_version is undeclared, not v1', () => {
    const verdict = resolveManifestVerdict({
      raw: 'kortix_version: one\n',
      format: 'yaml',
      path: 'kortix.yaml',
    });
    expect(verdict.version).toBeNull();
    expect(verdict.unknown_reason).toBe('undeclared');
    expect(verdict.migration_offered).toBe(false);
  });

  test('a zero or negative kortix_version is undeclared, not v1', () => {
    for (const raw of ['kortix_version: 0\n', 'kortix_version: -2\n']) {
      const verdict = resolveManifestVerdict({ raw, format: 'yaml', path: 'kortix.yaml' });
      expect(verdict.version).toBeNull();
      expect(verdict.unknown_reason).toBe('undeclared');
      expect(verdict.migration_offered).toBe(false);
    }
  });
});

describe('restrictedManifestVerdict', () => {
  test('a caller without customize.read gets unknown, never a migration prompt', () => {
    const verdict = restrictedManifestVerdict();
    expect(verdict.version).toBeNull();
    expect(verdict.unknown_reason).toBe('restricted');
    expect(verdict.migration_offered).toBe(false);
    expect(verdict.target_version).toBeNull();
    expect(verdict.path).toBeNull();
    expect(verdict.latest_version).toBe(LATEST_MANIFEST_VERSION);
  });
});
