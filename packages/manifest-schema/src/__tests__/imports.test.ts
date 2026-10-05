import { describe, expect, test } from 'bun:test';
import {
  type ManifestImportReader,
  IMPORT_PATH_PATTERN,
  ManifestImportError,
  manifestJsonSchema,
  normalizeImportPath,
  resolveManifestImports,
  splitManifestByOrigin,
  validateManifest,
} from '../index.ts';
import { parseManifestText, serializeManifestObject } from '../format.ts';

/** In-memory repo: path → YAML text. Mirrors what `git ls-tree -r` + `git show` give the API. */
function repo(files: Record<string, string>): ManifestImportReader {
  return {
    async list(path) {
      const dir = path.replace(/\/+$/, '');
      return Object.keys(files)
        .filter((p) => p === dir || p.startsWith(`${dir}/`))
        .map((p) => ({ path: p, revision: `sha-${p}` }));
    },
    async read(path) {
      const text = files[path];
      if (text === undefined) throw new Error(`missing ${path}`);
      return text;
    },
  };
}

const ROOT = `
kortix_version: 2
default_agent: kortix
imports:
  - .kortix/triggers/
  - .kortix/agents.yaml
agents:
  kortix:
    connectors: all
triggers:
  - slug: root-trigger
    type: cron
    cron: "0 9 * * *"
    prompt: from root
`;

const FILES = {
  'kortix.yaml': ROOT,
  '.kortix/agents.yaml': `
agents:
  galileo:
    connectors: [outlook]
`,
  '.kortix/triggers/reports/weekly.yaml': `
triggers:
  - slug: weekly-report
    type: cron
    cron: "0 15 * * 0"
    agent: galileo
    prompt: build the weekly report
`,
  '.kortix/triggers/dockets.yml': `
triggers:
  - slug: docket-monitor
    type: cron
    cron: "0 9 * * 1-5"
    prompt: check the docket
`,
  '.kortix/triggers/README.md': 'not yaml, must be skipped',
};

async function resolve(files: Record<string, string>, rootPath = 'kortix.yaml') {
  return resolveManifestImports(
    { path: rootPath, raw: parseManifestText(files[rootPath] ?? '', 'yaml'), revision: 'sha-root' },
    repo(files),
  );
}

describe('resolveManifestImports', () => {
  test('a manifest without `imports` resolves to itself and never touches the reader', async () => {
    const raw = parseManifestText('kortix_version: 2\ndefault_agent: a\nagents: {a: {}}\n', 'yaml');
    const reader: ManifestImportReader = {
      list: async () => {
        throw new Error('list must not be called');
      },
      read: async () => {
        throw new Error('read must not be called');
      },
    };
    const resolved = await resolveManifestImports({ path: 'kortix.yaml', raw, revision: 'r' }, reader);
    expect(resolved.raw).toEqual(raw);
    expect(resolved.files.map((f) => f.path)).toEqual(['kortix.yaml']);
  });

  test('merges a directory import recursively (sorted, .yaml + .yml only) and a file import', async () => {
    const resolved = await resolve(FILES);
    const slugs = (resolved.raw.triggers as Array<{ slug: string }>).map((t) => t.slug);
    // root entries first, then imports in declared order; a directory expands sorted by path
    expect(slugs).toEqual(['root-trigger', 'docket-monitor', 'weekly-report']);
    expect(Object.keys(resolved.raw.agents as object)).toEqual(['kortix', 'galileo']);
    expect(resolved.files.map((f) => f.path)).toEqual([
      'kortix.yaml',
      '.kortix/triggers/dockets.yml',
      '.kortix/triggers/reports/weekly.yaml',
      '.kortix/agents.yaml',
    ]);
    expect(resolved.origins.triggers).toEqual({
      'root-trigger': 'kortix.yaml',
      'docket-monitor': '.kortix/triggers/dockets.yml',
      'weekly-report': '.kortix/triggers/reports/weekly.yaml',
    });
    expect(resolved.origins.agents.galileo).toBe('.kortix/agents.yaml');
    expect(resolved.files[1]?.revision).toBe('sha-.kortix/triggers/dockets.yml');
  });

  test('the merged document passes the ordinary validator, including cross-file agent refs', async () => {
    const resolved = await resolve(FILES);
    const result = validateManifest(resolved.raw, 'yaml');
    expect(result.issues.filter((i) => i.severity === 'error')).toEqual([]);
  });

  test('an imported file may import further files (nesting)', async () => {
    const resolved = await resolve({
      'kortix.yaml': 'kortix_version: 2\nimports: [a.yaml]\n',
      'a.yaml': 'imports: [nested/b.yaml]\ntriggers:\n  - {slug: a, type: cron, cron: "* * * * *", prompt: a}\n',
      'nested/b.yaml': 'triggers:\n  - {slug: b, type: cron, cron: "* * * * *", prompt: b}\n',
    });
    expect((resolved.raw.triggers as Array<{ slug: string }>).map((t) => t.slug)).toEqual(['a', 'b']);
  });

  test('a file reachable twice is merged once', async () => {
    const resolved = await resolve({
      'kortix.yaml': 'kortix_version: 2\nimports: [dir/, dir/a.yaml]\n',
      'dir/a.yaml': 'triggers:\n  - {slug: a, type: cron, cron: "* * * * *", prompt: a}\n',
    });
    expect((resolved.raw.triggers as unknown[]).length).toBe(1);
  });

  const failures: Array<[string, Record<string, string>, RegExp]> = [
    [
      'a missing import',
      { 'kortix.yaml': 'kortix_version: 2\nimports: [nope.yaml]\n' },
      /kortix\.yaml: import "nope\.yaml" matches no \.yaml or \.yml file/,
    ],
    [
      'an import cycle',
      {
        'kortix.yaml': 'kortix_version: 2\nimports: [a.yaml]\n',
        'a.yaml': 'imports: [b.yaml]\n',
        'b.yaml': 'imports: [a.yaml]\n',
      },
      /import cycle: a\.yaml → b\.yaml → a\.yaml/,
    ],
    [
      'a duplicate trigger slug across files',
      {
        'kortix.yaml':
          'kortix_version: 2\nimports: [a.yaml]\ntriggers:\n  - {slug: dup, type: cron, cron: "* * * * *", prompt: x}\n',
        'a.yaml': 'triggers:\n  - {slug: dup, type: cron, cron: "* * * * *", prompt: y}\n',
      },
      /triggers "dup" is declared in both kortix\.yaml and a\.yaml/,
    ],
    [
      'a duplicate agent across files',
      {
        'kortix.yaml': 'kortix_version: 2\nimports: [a.yaml]\nagents: {kortix: {}}\n',
        'a.yaml': 'agents: {kortix: {secrets: all}}\n',
      },
      /agents "kortix" is declared in both kortix\.yaml and a\.yaml/,
    ],
    [
      'a root-only key in an imported file',
      {
        'kortix.yaml': 'kortix_version: 2\nimports: [a.yaml]\n',
        'a.yaml': 'default_agent: evil\n',
      },
      /a\.yaml: "default_agent" is only allowed in kortix\.yaml/,
    ],
    [
      'a path that escapes the repository',
      { 'kortix.yaml': 'kortix_version: 2\nimports: ["../outside.yaml"]\n' },
      /kortix\.yaml: import "\.\.\/outside\.yaml" must be a repository-relative path/,
    ],
    [
      'an absolute path',
      { 'kortix.yaml': 'kortix_version: 2\nimports: [/etc/passwd.yaml]\n' },
      /must be a repository-relative path/,
    ],
    [
      'a non-list `imports`',
      { 'kortix.yaml': 'kortix_version: 2\nimports: a.yaml\n' },
      /kortix\.yaml: `imports` must be a list of paths/,
    ],
    [
      'a wrong collection type in an imported file',
      {
        'kortix.yaml': 'kortix_version: 2\nimports: [a.yaml]\n',
        'a.yaml': 'triggers: {slug: a}\n',
      },
      /a\.yaml: `triggers` must be a list/,
    ],
    [
      'invalid YAML in an imported file',
      {
        'kortix.yaml': 'kortix_version: 2\nimports: [a.yaml]\n',
        'a.yaml': 'triggers: [\n',
      },
      /^a\.yaml: /,
    ],
  ];
  for (const [name, files, pattern] of failures) {
    test(`rejects ${name}`, async () => {
      const error = await resolve(files).then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(ManifestImportError);
      expect((error as Error).message).toMatch(pattern);
    });
  }
});

describe('splitManifestByOrigin', () => {
  test('an unchanged merged document splits back to exactly the files it came from', async () => {
    const resolved = await resolve(FILES);
    const split = splitManifestByOrigin(resolved, resolved.raw);
    for (const file of split) {
      const original = parseManifestText(FILES[file.path as keyof typeof FILES], 'yaml');
      expect(file.raw).toEqual(original);
      expect(file.changed).toBe(false);
    }
    expect(split.map((f) => f.path)).toEqual(resolved.files.map((f) => f.path));
  });

  test('an edit to an imported trigger changes only the file that declares it', async () => {
    const resolved = await resolve(FILES);
    const triggers = (resolved.raw.triggers as Array<Record<string, unknown>>).map((t) =>
      t.slug === 'weekly-report' ? { ...t, enabled: false } : t,
    );
    const split = splitManifestByOrigin(resolved, { ...resolved.raw, triggers });
    expect(split.filter((f) => f.changed).map((f) => f.path)).toEqual([
      '.kortix/triggers/reports/weekly.yaml',
    ]);
    const weekly = split.find((f) => f.path === '.kortix/triggers/reports/weekly.yaml');
    expect((weekly?.raw.triggers as Array<Record<string, unknown>>)[0]?.enabled).toBe(false);
  });

  test('a new entry lands in the root file; a removed entry leaves its own file', async () => {
    const resolved = await resolve(FILES);
    const triggers = [
      ...(resolved.raw.triggers as Array<Record<string, unknown>>).filter(
        (t) => t.slug !== 'docket-monitor',
      ),
      { slug: 'brand-new', type: 'cron', cron: '* * * * *', prompt: 'new' },
    ];
    const split = splitManifestByOrigin(resolved, { ...resolved.raw, triggers });
    expect(split.filter((f) => f.changed).map((f) => f.path).sort()).toEqual([
      '.kortix/triggers/dockets.yml',
      'kortix.yaml',
    ]);
    const root = split[0];
    expect((root?.raw.triggers as Array<{ slug: string }>).map((t) => t.slug)).toEqual([
      'root-trigger',
      'brand-new',
    ]);
    expect(root?.raw.imports).toEqual(['.kortix/triggers/', '.kortix/agents.yaml']);
    const dockets = split.find((f) => f.path === '.kortix/triggers/dockets.yml');
    // The emptied file keeps its key instead of collapsing to `{}`.
    expect(dockets?.raw).toEqual({ triggers: [] });
  });

  test('the root never absorbs imported entries when serialized', async () => {
    const resolved = await resolve(FILES);
    const split = splitManifestByOrigin(resolved, resolved.raw);
    const rootText = serializeManifestObject(split[0]?.raw ?? {}, 'yaml');
    expect(rootText).not.toContain('weekly-report');
    expect(rootText).not.toContain('galileo');
  });
});

describe('imports path rule — validator and JSON schema agree', () => {
  const cases: Array<[string, boolean]> = [
    ['.kortix/triggers/', true],
    ['.kortix/agents.yaml', true],
    ['triggers', true],
    ['a/b/c.yml', true],
    ['', false],
    [' a.yaml', false],
    ['a.yaml ', false],
    ['/abs.yaml', false],
    ['../up.yaml', false],
    ['a/../b.yaml', false],
    ['./a.yaml', false],
    ['a//b.yaml', false],
    ['a//', false],
    ['a\\b.yaml', false],
    ['dir/*.yaml', false],
    ['dir/{a,b}.yaml', false],
  ];
  for (const [path, ok] of cases) {
    test(`${JSON.stringify(path)} is ${ok ? 'accepted' : 'rejected'}`, () => {
      expect(normalizeImportPath(path) !== null).toBe(ok);
      expect(new RegExp(IMPORT_PATH_PATTERN).test(path)).toBe(ok);
      const result = validateManifest(
        { kortix_version: 2, default_agent: 'a', agents: { a: {} }, imports: [path] },
        'yaml',
      );
      expect(result.issues.some((i) => i.path === 'imports[0]')).toBe(!ok);
    });
  }

  test('the published v2 JSON schema declares `imports` with the same pattern', () => {
    const schema = manifestJsonSchema(2) as {
      properties: { imports: { items: { pattern: string } } };
    };
    expect(schema.properties.imports.items.pattern).toBe(IMPORT_PATH_PATTERN);
  });
});
