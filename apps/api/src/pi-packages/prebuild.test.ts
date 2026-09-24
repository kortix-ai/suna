import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { extensionEntries, prebuildPackages } from './prebuild';

let root: string;
let nodeModules: string;
let out: string;

function file(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function pkg(name: string, manifest: object, files: Record<string, string> = {}): string {
  const dir = join(nodeModules, name);
  file(join(dir, 'package.json'), JSON.stringify({ name, version: '1.2.3', ...manifest }));
  for (const [rel, contents] of Object.entries(files)) file(join(dir, rel), contents);
  return dir;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'prebuild-'));
  nodeModules = join(root, 'node_modules');
  out = join(root, 'out');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('extensionEntries — the files pi would load', () => {
  test('manifest files and folders; a `pi` field without extensions loads none', () => {
    const a = pkg('a', { pi: { extensions: ['./src/main.ts', './dist'] } }, { 'src/main.ts': '', 'dist/index.js': '', 'dist/other.js': '' });
    expect(extensionEntries(a)).toEqual([join(a, 'src/main.ts'), join(a, 'dist/index.js')]);
    const b = pkg('b', { pi: { skills: ['./skills'] } }, { 'extensions/x.ts': '' });
    expect(extensionEntries(b)).toEqual([]);
  });

  test('the conventional folder: its .ts/.js files and subfolder entries', () => {
    const c = pkg('c', {}, { 'extensions/one.ts': '', 'extensions/two.js': '', 'extensions/sub/index.ts': '', 'extensions/notes.md': '' });
    expect(extensionEntries(c)?.sort()).toEqual([join(c, 'extensions/one.ts'), join(c, 'extensions/sub/index.ts'), join(c, 'extensions/two.js')].sort());
  });

  test('globs, overrides and ignore files are pi\'s to resolve: null', () => {
    expect(extensionEntries(pkg('g', { pi: { extensions: ['./ext/*.ts'] } }, { 'ext/a.ts': '' }))).toBeNull();
    expect(extensionEntries(pkg('o', { pi: { extensions: ['./ext', '!./ext/b.ts'] } }, { 'ext/a.ts': '' }))).toBeNull();
    expect(extensionEntries(pkg('i', {}, { 'extensions/a.ts': '', 'extensions/.gitignore': 'a.ts' }))).toBeNull();
  });
});

describe('prebuildPackages', () => {
  test('one self-contained file per entry: pi modules read the host registry, deps and relative code are inlined', async () => {
    pkg('left-dep', { main: 'index.js' }, { 'index.js': 'exports.shout = (s) => s.toUpperCase();' });
    pkg('@acme/tool', { pi: { extensions: ['./index.ts'] } }, {
      'index.ts': [
        "import { Type } from 'typebox'",
        "import { defineTool } from '@earendil-works/pi-coding-agent'",
        "import { shout } from 'left-dep'",
        "import { label } from './lib/label'",
        'export default function (pi: any) { pi.registerTool(defineTool({ name: label, parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text", text: shout("x") }] }) })) }',
      ].join('\n'),
      'lib/label.ts': "export const label = 'acme'",
      'locales/en.json': '{"hi":"hi"}',
      'demo.mp4': 'video',
    });
    const manifest = await prebuildPackages(nodeModules, ['@acme/tool'], out);
    expect(manifest).toEqual({
      format: 'pi-packages-v3',
      packages: [{ name: '@acme/tool', version: '1.2.3', dir: 'packages/@acme/tool', extensions: ['packages/@acme/tool/index.ts.kortix.js'] }],
    });
    const built = readFileSync(join(out, 'packages/@acme/tool/index.ts.kortix.js'), 'utf8');
    // Minified: `["typebox"]` may print as `.typebox`.
    expect(built).toMatch(/globalThis\.__kortixPiHost(\.typebox|\["typebox"\])/);
    expect(built).toContain('globalThis.__kortixPiHost["@earendil-works/pi-coding-agent"]');
    expect(built).toContain('toUpperCase');
    expect(built).not.toMatch(/from\s+["'](typebox|left-dep|@earendil-works\/)/);
    // The package's own files travel (relative reads keep working); media does not.
    expect(existsSync(join(out, 'packages/@acme/tool/locales/en.json'))).toBe(true);
    expect(existsSync(join(out, 'packages/@acme/tool/demo.mp4'))).toBe(false);
    expect(JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'))).toEqual(manifest);
  });

  test('the object carries what runtime reads, not the code the entry inlined; the entry is minified with names kept', async () => {
    pkg('@acme/slim', { pi: { extensions: ['./dist/index.js'] } }, {
      'dist/index.js': [
        "import { helper } from './helper.js'",
        "import data from '../data/table.json'",
        'class NamedTool { run() { return helper(data.k) } }',
        'export default function (pi) { const tool = new NamedTool(); pi.registerTool({ name: tool.constructor.name, value: tool.run() }) }',
      ].join('\n'),
      'dist/helper.js': 'export const helper = (k) => k * 2',
      'dist/index.d.ts': 'export {}',
      'dist/index.js.map': '{}',
      'data/table.json': '{"k": 21}',
      'src/index.ts': 'export {}',
      'assets/page.html': '<html></html>',
      'README.md': '# slim',
      'CHANGELOG.md': '## 1.2.3',
      'LICENSE': 'MIT',
      'skills/slim/SKILL.md': '---\nname: slim\n---\n',
    });
    const manifest = await prebuildPackages(nodeModules, ['@acme/slim'], out);
    expect(manifest.packages).toEqual([{ name: '@acme/slim', version: '1.2.3', dir: 'packages/@acme/slim', extensions: ['packages/@acme/slim/dist/index.js.kortix.js'] }]);
    const dir = join(out, 'packages/@acme/slim');
    // Inlined code, type declarations, source maps and the package's docs stay out of the object.
    for (const rel of ['dist/index.js', 'dist/helper.js', 'dist/index.d.ts', 'dist/index.js.map', 'README.md', 'CHANGELOG.md']) {
      expect({ rel, present: existsSync(join(dir, rel)) }).toEqual({ rel, present: false });
    }
    // Kept: files code may read at runtime (even an inlined JSON), code the entry never imported, pi resources, the license.
    for (const rel of ['package.json', 'data/table.json', 'src/index.ts', 'assets/page.html', 'LICENSE', 'skills/slim/SKILL.md', 'dist/index.js.kortix.js']) {
      expect({ rel, present: existsSync(join(dir, rel)) }).toEqual({ rel, present: true });
    }
    const built = readFileSync(join(dir, 'dist/index.js.kortix.js'), 'utf8');
    expect(built.trim().split('\n').length).toBeLessThanOrEqual(2);
    // Identifiers are not renamed: an extension may rely on a class or function name.
    const tools: Array<{ name: string; value: number }> = [];
    (await import(join(dir, 'dist/index.js.kortix.js'))).default({ registerTool: (tool: { name: string; value: number }) => tools.push(tool) });
    expect(tools).toEqual([{ name: 'NamedTool', value: 42 }]);
  });

  test('a package cannot run code at build time through a Bun macro', async () => {
    const marker = join(root, 'macro-ran');
    pkg('sneaky', { pi: { extensions: ['./index.ts'] } }, {
      'macro.ts': `import { writeFileSync } from 'node:fs'\nexport function run() { writeFileSync(${JSON.stringify(marker)}, 'x'); return 1 }`,
      'index.ts': "import { run } from './macro.ts' with { type: 'macro' }\nexport default () => run()",
    });
    const manifest = await prebuildPackages(nodeModules, ['sneaky'], out);
    expect(existsSync(marker)).toBe(false);
    expect(manifest.packages[0]).toMatchObject({ fallback: expect.stringContaining('pre-build failed') });
  });

  test('what it cannot pre-build is named with a reason, for the node_modules fallback', async () => {
    pkg('globby', { pi: { extensions: ['./ext/*.ts'] } }, { 'ext/a.ts': 'export default () => {}' });
    pkg('broken', { pi: { extensions: ['./index.ts'] } }, { 'index.ts': "import 'no-such-package'\nexport default () => {}" });
    const manifest = await prebuildPackages(nodeModules, ['globby', 'broken'], out);
    expect(manifest.packages).toEqual([
      { name: 'globby', version: '1.2.3', fallback: 'extension paths use globs or overrides' },
      { name: 'broken', version: '1.2.3', fallback: expect.stringContaining('pre-build failed') },
    ]);
  });
});
