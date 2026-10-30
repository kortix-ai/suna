import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { envSpecFromManifest, formatIssueLine, loadLocalManifest, validateManifestFile } from '../manifest';

describe('envSpecFromManifest', () => {
  test('normalizes, uppercases, dedupes, and drops bad names', () => {
    const spec = envSpecFromManifest({
      env: {
        required: ['anthropic_api_key', 'ANTHROPIC_API_KEY', ' openai_api_key ', '1bad', 42],
        optional: ['foo'],
      },
    });
    expect(spec.required).toEqual(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY']);
    expect(spec.optional).toEqual(['FOO']);
  });

  test('missing [env] yields empty spec', () => {
    expect(envSpecFromManifest({})).toEqual({ required: [], optional: [] });
  });
});

describe('validateManifestFile', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kortix-validate-file-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('an unknown key is an error at its file, line and column, with a did-you-mean', () => {
    const file = join(dir, 'kortix.yaml');
    writeFileSync(file, 'default_agent: main\nagents:\n  main:\n    mode: primary\n    toolz: all\n');
    const { issues } = validateManifestFile(file);
    const issue = issues.find((i) => i.path === 'agents.main.toolz');
    expect(issue).toMatchObject({ file, severity: 'error', line: 5, column: 5 });
    expect(issue!.message).toContain('Did you mean "tools"?');
    expect(formatIssueLine(issue!, dir)).toStartWith('kortix.yaml:5:5  error  agents.main.toolz  ');
  });

  test('kortix_version: 3 is one deprecation; 2 is one legacy-format warning; any other value is one error', () => {
    const file = join(dir, 'kortix.yaml');
    writeFileSync(file, 'kortix_version: 3\nproject:\n  name: x\n');
    expect(validateManifestFile(file).issues).toEqual([
      expect.objectContaining({ path: 'kortix_version', severity: 'warning', fix: 'drop-kortix-version', file, line: 1, column: 1 }),
    ]);
    writeFileSync(file, 'kortix_version: 2\nproject:\n  name: x\n');
    expect(validateManifestFile(file).issues).toEqual([
      expect.objectContaining({ path: 'kortix_version', severity: 'warning', fix: 'legacy-format', file, line: 1, column: 1 }),
    ]);
    writeFileSync(file, 'kortix_version: 9\nproject:\n  name: x\n');
    expect(validateManifestFile(file).issues).toEqual([
      expect.objectContaining({ path: 'kortix_version', severity: 'error', file, line: 1 }),
    ]);
  });

  test('a YAML syntax error has no parsed document and keeps its position', () => {
    const file = join(dir, 'kortix.yaml');
    writeFileSync(file, 'project:\n  name: [x\n');
    const result = validateManifestFile(file);
    expect(result.parsed).toBeNull();
    expect(result.issues[0]).toMatchObject({ path: '<yaml>', severity: 'error', file });
    expect(result.issues[0]!.line).toBeGreaterThan(0);
  });
});

describe('loadLocalManifest', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kortix-manifest-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('returns null when there is no kortix.yaml', () => {
    expect(loadLocalManifest(dir)).toBeNull();
  });

  test('parses a kortix.yaml and extracts the env spec', () => {
    writeFileSync(join(dir, 'kortix.yaml'), `env:\n  required: [FOO]\n  optional: [bar]\n`);
    const m = loadLocalManifest(dir);
    expect(m).not.toBeNull();
    expect(m!.path.endsWith('kortix.yaml')).toBe(true);
    expect(m!.env.required).toEqual(['FOO']);
    expect(m!.env.optional).toEqual(['BAR']);
  });

  test('reads a legacy kortix.toml as the latest shape, and kortix.yml over it', () => {
    writeFileSync(join(dir, 'kortix.toml'), `kortix_version = 1\n[project]\nname = "from-toml"\n`);
    expect((loadLocalManifest(dir)!.data.project as { name: string }).name).toBe('from-toml');
    writeFileSync(join(dir, 'kortix.yml'), `project:\n  name: from-yml\n`);
    expect((loadLocalManifest(dir)!.data.project as { name: string }).name).toBe('from-yml');
  });

  test('throws on a YAML syntax error', () => {
    writeFileSync(join(dir, 'kortix.yaml'), `project:\n  name: [x\n`);
    expect(() => loadLocalManifest(dir)).toThrow();
  });
});

describe('manifest-edit — YAML (Document-AST editing, comment-preserving)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kortix-edit-yaml-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const FIXTURE = [
    'project:',
    '  name: demo',
    '',
    '# Nightly digest trigger',
    'triggers:',
    '  - slug: nightly # keep this comment',
    '    type: cron',
    '    cron: "0 9 * * *"',
    '    prompt: run it',
    '',
  ].join('\n');

  test('appendArrayBlock adds an entry and preserves existing comments', async () => {
    const { appendArrayBlock, arrayEntryExists, manifestFile } = await import('../manifest-edit');
    const { readFileSync } = await import('node:fs');
    writeFileSync(join(dir, 'kortix.yaml'), FIXTURE);
    appendArrayBlock('triggers', { slug: 'weekly', type: 'cron', cron: '0 0 * * 0', prompt: 'weekly run' }, dir);
    expect(arrayEntryExists('triggers', 'slug', 'weekly', dir)).toBe(true);
    expect(arrayEntryExists('triggers', 'slug', 'nightly', dir)).toBe(true);
    const text = readFileSync(manifestFile(dir), 'utf8');
    expect(text).toContain('# Nightly digest trigger');
    expect(text).toContain('# keep this comment');
  });

  test('removeArrayBlock excises the matching entry and preserves the surviving entry\'s comment', async () => {
    const { appendArrayBlock, removeArrayBlock, arrayEntryExists, manifestFile } = await import('../manifest-edit');
    const { readFileSync } = await import('node:fs');
    writeFileSync(join(dir, 'kortix.yaml'), FIXTURE);
    appendArrayBlock('triggers', { slug: 'weekly', type: 'cron', cron: '0 0 * * 0', prompt: 'weekly run' }, dir);
    expect(removeArrayBlock('triggers', 'slug', 'weekly', dir)).toBe(true);
    expect(arrayEntryExists('triggers', 'slug', 'weekly', dir)).toBe(false);
    expect(arrayEntryExists('triggers', 'slug', 'nightly', dir)).toBe(true);
    const text = readFileSync(manifestFile(dir), 'utf8');
    expect(text).toContain('# Nightly digest trigger');
    expect(text).toContain('# keep this comment');
  });

  test('removeArrayBlock returns false when no entry matches', async () => {
    const { removeArrayBlock } = await import('../manifest-edit');
    writeFileSync(join(dir, 'kortix.yaml'), FIXTURE);
    expect(removeArrayBlock('triggers', 'slug', 'nope', dir)).toBe(false);
  });

  test('setScalarInArrayBlock updates a scalar in place and preserves comments', async () => {
    const { setScalarInArrayBlock, readArrayEntry, manifestFile } = await import('../manifest-edit');
    const { readFileSync } = await import('node:fs');
    writeFileSync(join(dir, 'kortix.yaml'), FIXTURE);
    expect(setScalarInArrayBlock('triggers', 'slug', 'nightly', 'enabled', false, dir)).toBe(true);
    expect(readArrayEntry('triggers', 'slug', 'nightly', dir)?.enabled).toBe(false);
    const text = readFileSync(manifestFile(dir), 'utf8');
    expect(text).toContain('# Nightly digest trigger');
    expect(text).toContain('# keep this comment');
  });

  test('setScalarInArrayBlock returns false when no entry matches', async () => {
    const { setScalarInArrayBlock } = await import('../manifest-edit');
    writeFileSync(join(dir, 'kortix.yaml'), FIXTURE);
    expect(setScalarInArrayBlock('triggers', 'slug', 'nope', 'enabled', false, dir)).toBe(false);
  });

  test('setTableScalar creates a new table, then updates it in place, preserving comments', async () => {
    const { setTableScalar, manifestFile } = await import('../manifest-edit');
    const { readFileSync } = await import('node:fs');
    writeFileSync(join(dir, 'kortix.yaml'), FIXTURE);
    setTableScalar('policy', 'default_mode', 'ask', dir);
    let text = readFileSync(manifestFile(dir), 'utf8');
    expect(text).toContain('default_mode: ask');
    expect(text).toContain('# Nightly digest trigger');
    setTableScalar('policy', 'default_mode', 'allow', dir);
    text = readFileSync(manifestFile(dir), 'utf8');
    expect(text).toContain('default_mode: allow');
    expect(text).not.toContain('default_mode: ask');
    expect(text).toContain('# keep this comment');
  });

  test('appendArrayBlock auto-creates a nested dotted section (sandbox.templates)', async () => {
    const { appendArrayBlock, arrayEntryExists } = await import('../manifest-edit');
    writeFileSync(join(dir, 'kortix.yaml'), FIXTURE);
    appendArrayBlock('sandbox.templates', { slug: 'gpu', image: 'kortix/gpu:latest' }, dir);
    expect(arrayEntryExists('sandbox.templates', 'slug', 'gpu', dir)).toBe(true);
  });

  // `kortix connectors add` on a starter manifest re-indented every section
  // comment and re-flowed lists, because a missing section went through a
  // whole-document re-serialization.
  // Already in the latest shape: a write changes nothing but its own edit (a deprecated shape would be rewritten too).
  const STARTER = [
    'project:',
    '  description: "A long description that a re-serializer would fold onto a second line, which it must not"',
    'tools:',
    '  web_search: kortix:web_search      # maintained by Kortix',
    '',
    '# ─── Agents ───',
    '# Governance only.',
    'agents:',
    '  kortix:',
    '    tools: all',
    '    skills: [a, b]',
    '',
    '  # The AP agent.',
    '  ap-agent:',
    '    tools: all',
    '    connectors: []',
    '',
    'triggers:',
    '  - slug: nightly',
    '    type: cron',
    '',
    '# ─── Channels ───',
    '# Managed in the dashboard.',
    '',
  ].join('\n');

  test('appendArrayBlock adds a missing section without touching any existing byte', async () => {
    const { appendArrayBlock, arrayEntryExists, manifestFile } = await import('../manifest-edit');
    const { readFileSync } = await import('node:fs');
    writeFileSync(join(dir, 'kortix.yaml'), STARTER);
    appendArrayBlock('connectors', { slug: 'my-mcp', provider: 'mcp', url: 'https://x.example/mcp', auth: { type: 'bearer' } }, dir);
    const text = readFileSync(manifestFile(dir), 'utf8');
    expect(text.startsWith(STARTER)).toBe(true);
    expect(text.slice(STARTER.length)).toBe(
      '\nconnectors:\n  - slug: my-mcp\n    provider: mcp\n    url: https://x.example/mcp\n    auth:\n      type: bearer\n',
    );
    expect(arrayEntryExists('connectors', 'slug', 'my-mcp', dir)).toBe(true);
  });

  test('appendArrayBlock puts a new item before the comments that head the next section', async () => {
    const { appendArrayBlock, arrayEntryExists, manifestFile } = await import('../manifest-edit');
    const { readFileSync } = await import('node:fs');
    writeFileSync(join(dir, 'kortix.yaml'), STARTER);
    appendArrayBlock('triggers', { slug: 'weekly', type: 'cron' }, dir);
    const text = readFileSync(manifestFile(dir), 'utf8');
    expect(text).toBe(STARTER.replace('    type: cron\n', '    type: cron\n  - slug: weekly\n    type: cron\n'));
    expect(arrayEntryExists('triggers', 'slug', 'weekly', dir)).toBe(true);
  });

  test('appendArrayBlock under an existing parent map never duplicates the parent key', async () => {
    const { appendArrayBlock, arrayEntryExists, manifestFile } = await import('../manifest-edit');
    const { readFileSync } = await import('node:fs');
    writeFileSync(join(dir, 'kortix.yaml'), 'sandbox:\n  default: python\n');
    appendArrayBlock('sandbox.templates', { slug: 'gpu', image: 'kortix/gpu:latest' }, dir);
    expect(readFileSync(manifestFile(dir), 'utf8').match(/^sandbox:/gm)?.length).toBe(1);
    expect(arrayEntryExists('sandbox.templates', 'slug', 'gpu', dir)).toBe(true);
  });

  test('every write drops the obsolete kortix_version line and keeps every other byte', async () => {
    const { appendArrayBlock, setScalarInArrayBlock, removeArrayBlock, setTableScalar, manifestFile } = await import('../manifest-edit');
    const { readFileSync } = await import('node:fs');
    const edits: Array<() => unknown> = [
      () => appendArrayBlock('triggers', { slug: 'weekly', type: 'cron' }, dir),
      () => setScalarInArrayBlock('triggers', 'slug', 'nightly', 'enabled', false, dir),
      () => removeArrayBlock('triggers', 'slug', 'nightly', dir),
      () => setTableScalar('policy', 'default_mode', 'ask', dir),
    ];
    for (const edit of edits) {
      writeFileSync(join(dir, 'kortix.yaml'), `kortix_version: 3\n${FIXTURE}`);
      edit();
      const text = readFileSync(manifestFile(dir), 'utf8');
      expect(text).not.toContain('kortix_version');
      expect(text.startsWith('project:\n  name: demo\n')).toBe(true);
    }
  });

  test('preserves every unrelated YAML byte during a targeted scalar edit', async () => {
    const { setScalarInArrayBlock, manifestFile } = await import('../manifest-edit');
    const { readFileSync } = await import('node:fs');
    const before = [
      'metadata: { owner: "ops", labels: [alpha,beta] } # exact flow style',
      '',
      'triggers:',
      '  - slug: nightly # exact trigger comment',
      '    enabled: true',
      '    prompt: "keep quoting"',
      '',
      'tail:  value   # exact spaces',
      '',
    ].join('\n');
    writeFileSync(join(dir, 'kortix.yaml'), before);

    expect(setScalarInArrayBlock('triggers', 'slug', 'nightly', 'enabled', false, dir)).toBe(true);

    const after = readFileSync(manifestFile(dir), 'utf8');
    expect(after).toBe(before.replace('    enabled: true', '    enabled: false'));
  });

  test('preserves every existing YAML byte when appending one array entry', async () => {
    const { appendArrayBlock, manifestFile } = await import('../manifest-edit');
    const { readFileSync } = await import('node:fs');
    const before = [
      'metadata: { owner: "ops", labels: [alpha,beta] } # exact flow style',
      '',
      'connectors:',
      '  - slug: first # exact connector comment',
      '    provider: http',
      '',
      'tail:  value   # exact spaces',
      '',
    ].join('\n');
    writeFileSync(join(dir, 'kortix.yaml'), before);

    appendArrayBlock('connectors', { slug: 'second', provider: 'mcp', url: 'https://mcp.test' }, dir);

    const after = readFileSync(manifestFile(dir), 'utf8');
    expect(after).toBe(
      before.replace(
        '\n\ntail:  value',
        '\n  - slug: second\n    provider: mcp\n    url: https://mcp.test\n\ntail:  value',
      ),
    );
  });

  test('removes only the selected YAML array entry bytes', async () => {
    const { removeArrayBlock, manifestFile } = await import('../manifest-edit');
    const { readFileSync } = await import('node:fs');
    const before = [
      'connectors:',
      '  - slug: first # keep inline',
      '    provider: http',
      '  # remove with second',
      '  - slug: second',
      '    provider: mcp',
      'tail:  [x,y] # exact tail',
      '',
    ].join('\n');
    writeFileSync(join(dir, 'kortix.yaml'), before);

    expect(removeArrayBlock('connectors', 'slug', 'second', dir)).toBe(true);

    const after = readFileSync(manifestFile(dir), 'utf8');
    expect(after).toBe(
      before.replace('  # remove with second\n  - slug: second\n    provider: mcp\n', ''),
    );
  });

  test('updates and appends a YAML table scalar without changing unrelated bytes', async () => {
    const { setTableScalar, manifestFile } = await import('../manifest-edit');
    const { readFileSync } = await import('node:fs');
    const before = [
      'policy:',
      '  default_mode: ask # keep this comment',
      'tail:  [x,y] # exact tail',
      '',
    ].join('\n');
    writeFileSync(join(dir, 'kortix.yaml'), before);

    setTableScalar('policy', 'default_mode', 'allow_all', dir);
    expect(readFileSync(manifestFile(dir), 'utf8')).toBe(
      before.replace('default_mode: ask', 'default_mode: allow_all'),
    );

    setTableScalar('policy', 'review', true, dir);
    expect(readFileSync(manifestFile(dir), 'utf8')).toBe(
      before
        .replace('default_mode: ask', 'default_mode: allow_all')
        .replace('tail:  [x,y]', '  review: true\ntail:  [x,y]'),
    );
  });
});
