/**
 * Parser-level tests for `[[apps]]` in kortix.toml.
 * Exercises every accepted config shape (the user explicitly asked for
 * coverage across all of them) plus the rejection paths.
 */
import { describe, expect, test } from 'bun:test';
import {
  appSpecToTomlEntry,
  extractApps,
  manifestHashForApp,
  type AppSpec,
} from '../projects/apps';
import {
  KNOWN_SCHEMA_VERSION,
  parseManifestString,
  serializeManifest,
} from '../projects/triggers';

const MIN_PROJECT = `
[project]
name = "test"
`;

function manifestWith(body: string): string {
  return [`kortix_version = ${KNOWN_SCHEMA_VERSION}`, MIN_PROJECT, body].join('\n');
}

function parseAndExtract(body: string) {
  return extractApps(parseManifestString(manifestWith(body)));
}

describe('[[apps]] — happy paths', () => {
  test('minimal git app with just slug + domains + source', () => {
    const { specs, errors } = parseAndExtract(`
[[apps]]
slug = "site"
domains = ["site.style.dev"]

  [apps.source]
  type = "git"
  repo = "https://github.com/me/site"
`);
    expect(errors).toEqual([]);
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({
      slug: 'site',
      name: 'site',
      enabled: true,
      domains: ['site.style.dev'],
      framework: null,
      build: null,
      env: {},
      source: { type: 'git', repo: 'https://github.com/me/site', branch: null, rootPath: null },
    });
    expect(specs[0]!.path).toBe('kortix.toml#apps.site');
  });

  test('full git app — every field exercised', () => {
    const { specs, errors } = parseAndExtract(`
[[apps]]
slug = "marketing-site"
name = "Marketing site"
enabled = true
provider = "freestyle"
domains = ["marketing.style.dev", "marketing.example.com"]
framework = "next"

  [apps.source]
  type = "git"
  repo = "https://github.com/me/monorepo"
  branch = "main"
  root_path = "apps/marketing"

  [apps.build]
  command = "pnpm build"
  out_dir = "dist"

  [apps.env]
  NEXT_PUBLIC_API_URL = "https://api.example.com"
  NODE_ENV = "production"
`);
    expect(errors).toEqual([]);
    expect(specs[0]).toMatchObject({
      slug: 'marketing-site',
      name: 'Marketing site',
      enabled: true,
      domains: ['marketing.style.dev', 'marketing.example.com'],
      framework: 'next',
      build: { command: 'pnpm build', outDir: 'dist' },
      env: { NEXT_PUBLIC_API_URL: 'https://api.example.com', NODE_ENV: 'production' },
      source: { type: 'git', repo: 'https://github.com/me/monorepo', branch: 'main', rootPath: 'apps/marketing' },
    });
  });

  test('git source with no repo (defaults to project repo at deploy-time)', () => {
    const { specs, errors } = parseAndExtract(`
[[apps]]
slug = "self"
domains = ["self.style.dev"]

  [apps.source]
  type = "git"
`);
    expect(errors).toEqual([]);
    expect(specs[0]!.source).toEqual({ type: 'git', repo: null, branch: null, rootPath: null });
  });

  test('tar source', () => {
    const { specs, errors } = parseAndExtract(`
[[apps]]
slug = "tarball"
domains = ["tarball.style.dev"]

  [apps.source]
  type = "tar"
  url = "https://example.com/builds/site.tar.gz"
`);
    expect(errors).toEqual([]);
    expect(specs[0]!.source).toEqual({ type: 'tar', url: 'https://example.com/builds/site.tar.gz' });
  });

  test('build with only command (no out_dir)', () => {
    const { specs, errors } = parseAndExtract(`
[[apps]]
slug = "build-only-cmd"
domains = ["b1.style.dev"]

  [apps.source]
  type = "git"
  repo = "https://github.com/me/x"

  [apps.build]
  command = "bun build"
`);
    expect(errors).toEqual([]);
    expect(specs[0]!.build).toEqual({ command: 'bun build', outDir: null });
  });

  test('build table present but empty collapses to null', () => {
    const { specs, errors } = parseAndExtract(`
[[apps]]
slug = "build-empty"
domains = ["b2.style.dev"]

  [apps.source]
  type = "git"
  repo = "https://github.com/me/x"

  [apps.build]
`);
    expect(errors).toEqual([]);
    expect(specs[0]!.build).toBeNull();
  });

  test('rootPath camelCase alias is ignored in favor of root_path', () => {
    const { specs, errors } = parseAndExtract(`
[[apps]]
slug = "camel"
domains = ["c.style.dev"]

  [apps.source]
  type = "git"
  repo = "https://github.com/me/x"
  rootPath = "apps/x"
`);
    expect(errors).toEqual([]);
    expect(specs[0]!.source).toMatchObject({ rootPath: null });
  });

  test('outDir camelCase alias is ignored in favor of out_dir', () => {
    const { specs, errors } = parseAndExtract(`
[[apps]]
slug = "camel-build"
domains = ["cb.style.dev"]

  [apps.source]
  type = "git"
  repo = "https://github.com/me/x"

  [apps.build]
  command = "bun run build"
  outDir = "out"
`);
    expect(errors).toEqual([]);
    expect(specs[0]!.build).toEqual({ command: 'bun run build', outDir: null });
  });

  test('enabled = false is preserved', () => {
    const { specs, errors } = parseAndExtract(`
[[apps]]
slug = "off"
enabled = false
domains = ["off.style.dev"]

  [apps.source]
  type = "git"
  repo = "https://github.com/me/x"
`);
    expect(errors).toEqual([]);
    expect(specs[0]!.enabled).toBe(false);
  });

  test('multiple [[apps]] in one manifest sort A-Z by slug', () => {
    const { specs, errors } = parseAndExtract(`
[[apps]]
slug = "zeta"
domains = ["zeta.style.dev"]

  [apps.source]
  type = "git"
  repo = "https://github.com/me/zeta"

[[apps]]
slug = "alpha"
domains = ["alpha.style.dev"]

  [apps.source]
  type = "tar"
  url = "https://example.com/alpha.tar.gz"

[[apps]]
slug = "mid"
domains = ["mid.style.dev"]

  [apps.source]
  type = "git"
  repo = "https://github.com/me/mid"
`);
    expect(errors).toEqual([]);
    expect(specs.map((s) => s.slug)).toEqual(['alpha', 'mid', 'zeta']);
  });

  test('no [[apps]] block at all is a clean empty', () => {
    const { specs, errors } = parseAndExtract(``);
    expect(specs).toEqual([]);
    expect(errors).toEqual([]);
  });
});

describe('[[apps]] — round-trip via appSpecToTomlEntry', () => {
  test('a full spec round-trips back through serialize + parse unchanged', () => {
    const manifest = parseManifestString(manifestWith(`
[[apps]]
slug = "rt"
name = "Round-trip"
enabled = true
provider = "freestyle"
domains = ["rt.style.dev"]
framework = "next"

  [apps.source]
  type = "git"
  repo = "https://github.com/me/rt"
  branch = "main"
  root_path = "apps/rt"

  [apps.build]
  command = "pnpm build"
  out_dir = "dist"

  [apps.env]
  FOO = "bar"
`));
    const { specs } = extractApps(manifest);
    const entry = appSpecToTomlEntry(specs[0] as AppSpec);
    // Re-pack into a fresh manifest and re-parse — every field survives.
    const next = { ...manifest, raw: { ...manifest.raw, apps: [entry] } };
    const serialized = serializeManifest(next);
    expect(serialized).toContain('[[apps]]'); // sanity: nothing obviously corrupted
    const reparsed = extractApps(parseManifestString(serialized));
    expect(reparsed.errors).toEqual([]);
    expect(reparsed.specs[0]).toMatchObject({
      slug: 'rt',
      name: 'Round-trip',
      enabled: true,
      framework: 'next',
      domains: ['rt.style.dev'],
      build: { command: 'pnpm build', outDir: 'dist' },
      env: { FOO: 'bar' },
      source: { type: 'git', repo: 'https://github.com/me/rt', branch: 'main', rootPath: 'apps/rt' },
    });
  });

  test('tar source round-trips', () => {
    const spec: AppSpec = {
      slug: 'tarball',
      path: 'kortix.toml#apps.tarball',
      name: 'Tarball',
      enabled: true,
      source: { type: 'tar', url: 'https://example.com/t.tar.gz' },
      build: null,
      env: {},
      domains: ['t.style.dev'],
      framework: null,
    };
    const entry = appSpecToTomlEntry(spec);
    const reparsed = extractApps({
      schemaVersion: KNOWN_SCHEMA_VERSION,
      raw: { project: { name: 't' }, apps: [entry] },
    });
    expect(reparsed.errors).toEqual([]);
    expect(reparsed.specs[0]!.source).toEqual({ type: 'tar', url: 'https://example.com/t.tar.gz' });
  });
});

describe('[[apps]] — rejection paths', () => {
  test('top-level [apps] (single table, not array) is rejected', () => {
    const { specs, errors } = parseAndExtract(`
[apps]
slug = "wrong"
`);
    expect(specs).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.error).toMatch(/must be an array of tables/);
  });

  test('missing slug', () => {
    const { specs, errors } = parseAndExtract(`
[[apps]]
domains = ["x.style.dev"]

  [apps.source]
  type = "git"
  repo = "https://github.com/me/x"
`);
    expect(specs).toEqual([]);
    expect(errors[0]!.error).toMatch(/missing a slug/);
  });

  test('invalid slug shape', () => {
    const { specs, errors } = parseAndExtract(`
[[apps]]
slug = "BAD SLUG!"
domains = ["x.style.dev"]

  [apps.source]
  type = "git"
  repo = "https://github.com/me/x"
`);
    expect(specs).toEqual([]);
    expect(errors[0]!.error).toMatch(/Invalid slug/);
  });

  test('enabled must be a boolean', () => {
    const { specs, errors } = parseAndExtract(`
[[apps]]
slug = "string-enabled"
enabled = "false"
domains = ["x.style.dev"]

  [apps.source]
  type = "git"
  repo = "https://github.com/me/x"
`);
    expect(specs).toEqual([]);
    expect(errors[0]!.error).toMatch(/enabled must be a boolean/);
  });

  test('provider field is ignored by the manifest parser', () => {
    const { specs, errors } = parseAndExtract(`
[[apps]]
slug = "x"
provider = "magic-cloud"
domains = ["x.style.dev"]

  [apps.source]
  type = "git"
  repo = "https://github.com/me/x"
`);
    expect(errors).toEqual([]);
    expect(specs).toHaveLength(1);
    expect(specs[0]).not.toHaveProperty('provider');
  });

  test('missing domains is allowed (auto-issued *.style.dev at deploy)', () => {
    const { specs, errors } = parseAndExtract(`
[[apps]]
slug = "x"

  [apps.source]
  type = "git"
  repo = "https://github.com/me/x"
`);
    expect(errors).toEqual([]);
    expect(specs).toHaveLength(1);
    expect(specs[0]!.domains).toEqual([]);
  });

  test('empty domains array is allowed', () => {
    const { specs, errors } = parseAndExtract(`
[[apps]]
slug = "x"
domains = []

  [apps.source]
  type = "git"
  repo = "https://github.com/me/x"
`);
    expect(errors).toEqual([]);
    expect(specs).toHaveLength(1);
    expect(specs[0]!.domains).toEqual([]);
  });

  test('non-array domains is still rejected', () => {
    const { specs, errors } = parseAndExtract(`
[[apps]]
slug = "x"
domains = "nope.style.dev"

  [apps.source]
  type = "git"
  repo = "https://github.com/me/x"
`);
    expect(specs).toEqual([]);
    expect(errors[0]!.error).toMatch(/domains must be an array/);
  });

  test('missing source block', () => {
    const { specs, errors } = parseAndExtract(`
[[apps]]
slug = "x"
domains = ["x.style.dev"]
`);
    expect(specs).toEqual([]);
    expect(errors[0]!.error).toMatch(/\[apps\.source\] is required/);
  });

  test('source.type unknown', () => {
    const { specs, errors } = parseAndExtract(`
[[apps]]
slug = "x"
domains = ["x.style.dev"]

  [apps.source]
  type = "smoke-signal"
`);
    expect(specs).toEqual([]);
    expect(errors[0]!.error).toMatch(/must be "git" or "tar"/);
  });

  test('tar source without url', () => {
    const { specs, errors } = parseAndExtract(`
[[apps]]
slug = "x"
domains = ["x.style.dev"]

  [apps.source]
  type = "tar"
`);
    expect(specs).toEqual([]);
    expect(errors[0]!.error).toMatch(/non-empty url/);
  });

  test('env value not a string', () => {
    const { specs, errors } = parseAndExtract(`
[[apps]]
slug = "x"
domains = ["x.style.dev"]

  [apps.source]
  type = "git"
  repo = "https://github.com/me/x"

  [apps.env]
  FOO = 42
`);
    expect(specs).toEqual([]);
    expect(errors[0]!.error).toMatch(/must be a string/);
  });

  test('env key not a valid identifier', () => {
    const { specs, errors } = parseAndExtract(`
[[apps]]
slug = "x"
domains = ["x.style.dev"]

  [apps.source]
  type = "git"
  repo = "https://github.com/me/x"

  [apps.env]
  "1bad" = "x"
`);
    expect(specs).toEqual([]);
    expect(errors[0]!.error).toMatch(/env var name/);
  });

  test('duplicate slugs — first kept, second flagged', () => {
    const { specs, errors } = parseAndExtract(`
[[apps]]
slug = "dup"
domains = ["d1.style.dev"]

  [apps.source]
  type = "git"
  repo = "https://github.com/me/x"

[[apps]]
slug = "dup"
domains = ["d2.style.dev"]

  [apps.source]
  type = "git"
  repo = "https://github.com/me/y"
`);
    expect(specs).toHaveLength(1);
    expect(specs[0]!.domains).toEqual(['d1.style.dev']);
    expect(errors[0]!.error).toMatch(/Duplicate app slug/);
  });
});

describe('manifestHashForApp', () => {
  function baseSpec(overrides: Partial<AppSpec> = {}): AppSpec {
    return {
      slug: 'site',
      path: 'kortix.toml#apps.site',
      name: 'Site',
      enabled: true,
      source: { type: 'git', repo: 'https://github.com/me/x', branch: null, rootPath: null },
      build: null,
      env: {},
      domains: ['site.style.dev'],
      framework: null,
      ...overrides,
    };
  }

  test('hash is stable across identical specs', () => {
    expect(manifestHashForApp(baseSpec())).toBe(manifestHashForApp(baseSpec()));
  });

  test('hash ignores slug + name (renaming is not a redeploy)', () => {
    expect(manifestHashForApp(baseSpec({ slug: 'a', name: 'A' })))
      .toBe(manifestHashForApp(baseSpec({ slug: 'b', name: 'B' })));
  });

  test('hash changes when source changes', () => {
    expect(manifestHashForApp(baseSpec({ source: { type: 'git', repo: 'https://github.com/me/x', branch: 'main', rootPath: null } })))
      .not.toBe(manifestHashForApp(baseSpec()));
  });

  test('hash changes when env changes', () => {
    expect(manifestHashForApp(baseSpec({ env: { FOO: 'bar' } })))
      .not.toBe(manifestHashForApp(baseSpec()));
  });

  test('hash ignores domain ordering', () => {
    expect(manifestHashForApp(baseSpec({ domains: ['a.dev', 'b.dev'] })))
      .toBe(manifestHashForApp(baseSpec({ domains: ['b.dev', 'a.dev'] })));
  });
});

// `loadProjectApps` is covered via the e2e suite (it walks the manifest
// IO + parser end-to-end with a stubbed git module). Skipped here because
// running it without mocking pulls in the real readRepoFile path, and
// bun-test mock ordering across files makes it flaky.
