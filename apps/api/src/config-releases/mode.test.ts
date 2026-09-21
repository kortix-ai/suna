import { describe, expect, test } from 'bun:test';
import type { ConfigRelease } from './builder';
import { ConfigReleaseRequestSchema, decideConfigMode, MAX_WORKSPACE_REPORT_ENTRIES } from './mode';

const HEAD = 'a'.repeat(40);
const BLOB = 'b'.repeat(40);

const report = (changed: unknown[]) => ({ workspace: { head: HEAD, config_dir: '.kortix/opencode', changed } });

describe('ConfigReleaseRequestSchema', () => {
  test('accepts the spec example, a null report, and an empty body', () => {
    expect(
      ConfigReleaseRequestSchema.safeParse(
        report([
          { path: '.kortix/opencode/agents/kortix.md', status: 'modified', blob: BLOB },
          { path: '.kortix/opencode/skills/x/SKILL.md', status: 'deleted', blob: null },
          { path: '.kortix/opencode/new.md', status: 'untracked', blob: BLOB },
          { path: '.kortix/opencode/added.md', status: 'added', blob: BLOB },
        ]),
      ).success,
    ).toBe(true);
    expect(ConfigReleaseRequestSchema.safeParse({ workspace: null }).success).toBe(true);
    // SHA-256 repositories: 64-hex head and blob IDs.
    expect(
      ConfigReleaseRequestSchema.safeParse({
        workspace: {
          head: 'c'.repeat(64),
          config_dir: '.kortix/opencode',
          committed_scope: 'base-sha',
          changed: [{ path: '.kortix/opencode/a.md', status: 'modified', blob: 'd'.repeat(64) }],
        },
      }).success,
    ).toBe(true);
    for (const scope of ['remote', 'base-sha', 'none']) {
      expect(ConfigReleaseRequestSchema.safeParse({ workspace: { head: HEAD, config_dir: '.k', committed_scope: scope, changed: [] } }).success).toBe(true);
    }
    expect(ConfigReleaseRequestSchema.safeParse({ workspace: { head: HEAD, config_dir: '.k', package_json: '{}', changed: [] } }).success).toBe(true);
    expect(ConfigReleaseRequestSchema.safeParse({}).success).toBe(true);
  });

  test.each([
    ['a non-object body', 'report'],
    ['an unknown top-level key', { workspace: null, descriptor: {} }],
    ['a short head', { workspace: { head: 'abc', config_dir: '.kortix/opencode', changed: [] } }],
    ['an absolute config dir', { workspace: { head: HEAD, config_dir: '/etc', changed: [] } }],
    ['an unknown status', report([{ path: 'a', status: 'renamed', blob: BLOB }])],
    ['a deleted file with a blob', report([{ path: 'a', status: 'deleted', blob: BLOB }])],
    ['a modified file without a blob', report([{ path: 'a', status: 'modified', blob: null }])],
    ['an uppercase blob', report([{ path: 'a', status: 'modified', blob: 'B'.repeat(40) }])],
    ['a 50-hex blob', report([{ path: 'a', status: 'modified', blob: 'b'.repeat(50) }])],
    ['an unknown committed_scope', { workspace: { head: HEAD, config_dir: '.k', committed_scope: 'all', changed: [] } }],
    ['a path with ..', report([{ path: '.kortix/../x', status: 'modified', blob: BLOB }])],
    ['an extra entry key', report([{ path: 'a', status: 'modified', blob: BLOB, mode: '100644' }])],
  ])('rejects %s', (_label, body) => {
    expect(ConfigReleaseRequestSchema.safeParse(body).success).toBe(false);
  });

  test('bounds the number of entries', () => {
    const many = Array.from({ length: MAX_WORKSPACE_REPORT_ENTRIES + 1 }, (_, i) => ({
      path: `f${i}`,
      status: 'modified',
      blob: BLOB,
    }));
    expect(ConfigReleaseRequestSchema.safeParse(report(many)).success).toBe(false);
  });
});

