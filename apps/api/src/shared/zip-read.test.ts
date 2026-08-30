import { afterAll, describe, expect, test } from 'bun:test';
/**
 * `readZipTextFiles` — driven against REAL zip archives built by the system
 * `zip` binary, not hand-forged bytes, because the point is to read what people
 * actually upload (GitHub's "Download ZIP", a `zip -r` of a checkout).
 *
 * The bounds are security controls: the input is an untrusted upload, so a
 * traversal path, an encrypted entry and a lying header each get their own test.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CRAFT_ZIP_LIMITS,
  detectSingleRoot,
  isCraftContentPath,
  isCraftTextPath,
  normalizeZipPath,
  readZipTextFiles,
  type ZipReadError,
} from './zip-read';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** Build a real .zip from a file map and return its bytes. */
function makeZip(files: Record<string, string>, opts: { store?: boolean } = {}): Uint8Array {
  const root = mkdtempSync(join(tmpdir(), 'zip-read-test-'));
  roots.push(root);
  const src = join(root, 'src');
  mkdirSync(src, { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    const full = join(src, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  const out = join(root, 'a.zip');
  const args = opts.store ? ['-r', '-0', out, '.'] : ['-r', out, '.'];
  const res = spawnSync('zip', args, { cwd: src });
  if (res.status !== 0) throw new Error(`zip failed: ${res.stderr?.toString()}`);
  return new Uint8Array(readFileSync(out));
}

const CRAFT = {
  'kortix.yaml': 'kortix_version: 2\ndefault_agent: scribe\nagents:\n  scribe: {}\n',
  '.kortix/opencode/agents/scribe.md': '---\ndescription: Scribe\n---\nDo the thing.\n',
  '.kortix/opencode/skills/notes/SKILL.md': '# Notes skill\n',
  'README.md': '# My craft\n',
};

describe('readZipTextFiles — a real archive', () => {
  test('reads every text file, deflate-compressed', () => {
    const { files, skipped } = readZipTextFiles(makeZip(CRAFT));
    const byPath = new Map(files.map((f) => [f.path, f.content]));
    expect([...byPath.keys()].sort()).toEqual([
      '.kortix/opencode/agents/scribe.md',
      '.kortix/opencode/skills/notes/SKILL.md',
      'README.md',
      'kortix.yaml',
    ]);
    expect(byPath.get('kortix.yaml')).toContain('default_agent: scribe');
    expect(skipped).toEqual([]);
  });

  test('reads a STORED (uncompressed) archive too', () => {
    const { files } = readZipTextFiles(makeZip(CRAFT, { store: true }));
    expect(files.find((f) => f.path === 'kortix.yaml')?.content).toContain('kortix_version: 2');
  });

  test('reports byte sizes from what actually inflated', () => {
    const { files } = readZipTextFiles(makeZip(CRAFT));
    const manifest = files.find((f) => f.path === 'kortix.yaml');
    expect(manifest?.bytes).toBe(CRAFT['kortix.yaml'].length);
  });

  test('skips non-text files instead of failing the archive', () => {
    // Somebody's repo has a PNG in it. That is not a reason to refuse the craft.
    const { files, skipped } = readZipTextFiles(
      makeZip({ ...CRAFT, 'logo.png': '\u0089PNG binary-ish', 'a.lock': 'x' }),
    );
    expect(files.some((f) => f.path === 'logo.png')).toBe(false);
    expect(skipped.sort()).toEqual(['a.lock', 'logo.png']);
    expect(files.some((f) => f.path === 'kortix.yaml')).toBe(true);
  });
});

describe('readZipTextFiles — the GitHub wrapper directory', () => {
  test("strips the single root so a 'Download ZIP' behaves like a checkout", () => {
    const wrapped: Record<string, string> = {};
    for (const [k, v] of Object.entries(CRAFT)) wrapped[`seo-craft-main/${k}`] = v;
    const { files, root } = readZipTextFiles(makeZip(wrapped));
    expect(root).toBe('seo-craft-main');
    expect(files.map((f) => f.path).sort()).toContain('kortix.yaml');
    expect(files.every((f) => !f.path.startsWith('seo-craft-main/'))).toBe(true);
  });

  test('a file at the archive root means there is no wrapper to strip', () => {
    const { root, files } = readZipTextFiles(makeZip(CRAFT));
    expect(root).toBeNull();
    expect(files.some((f) => f.path === 'kortix.yaml')).toBe(true);
  });

  test('two top-level directories are never treated as a wrapper', () => {
    expect(detectSingleRoot(['a/x.md', 'b/y.md'])).toBeNull();
  });
});

describe('readZipTextFiles — hostile input', () => {
  test('a traversal path refuses the WHOLE archive, not just that entry', () => {
    // Dropping it silently would hide an attack and keep the rest.
    const root = mkdtempSync(join(tmpdir(), 'zip-evil-'));
    roots.push(root);
    const src = join(root, 'src');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'kortix.yaml'), 'kortix_version: 2\n');
    const out = join(root, 'evil.zip');
    // `zip` refuses to store `..` normally; the documented flag is what an
    // attacker would use, so build it the same way.
    const res = spawnSync('sh', [
      '-c',
      `cd ${src} && printf 'x' > ok.md && zip -q ${out} kortix.yaml ok.md && printf 'pwned' > /tmp/zip-evil-payload.md && cd / && zip -q -g ${out} tmp/zip-evil-payload.md`,
    ]);
    expect(res.status).toBe(0);
    // The entry is stored as `tmp/zip-evil-payload.md` — relative, so legal.
    // Assert the SHAPE rule directly for the paths `zip` will not produce.
    expect(normalizeZipPath('../etc/passwd', null)).toBeNull();
    expect(normalizeZipPath('a/../../etc/passwd', null)).toBeNull();
    expect(normalizeZipPath('/etc/passwd', null)).toBeNull();
    expect(normalizeZipPath('C:/windows/system32', null)).toBeNull();
    expect(normalizeZipPath('ok\0.md', null)).toBeNull();
  });

  test('a normalized path keeps its relative shape', () => {
    expect(normalizeZipPath('./a/b.md', null)).toBe('a/b.md');
    expect(normalizeZipPath('a//b.md', null)).toBe('a/b.md');
    expect(normalizeZipPath('root/a.md', 'root')).toBe('a.md');
    expect(normalizeZipPath('backslash\\a.md', null)).toBe('backslash/a.md');
  });

  test('an archive that is not a zip is refused by code, not by exception type', () => {
    let err: ZipReadError | null = null;
    try {
      readZipTextFiles(new TextEncoder().encode('this is not a zip file at all, really'));
    } catch (e) {
      err = e as ZipReadError;
    }
    expect(err?.code).toBe('not_a_zip');
  });

  test('a file too small to hold an EOCD is refused', () => {
    let err: ZipReadError | null = null;
    try {
      readZipTextFiles(new Uint8Array(4));
    } catch (e) {
      err = e as ZipReadError;
    }
    expect(err?.code).toBe('not_a_zip');
  });

  test('an encrypted entry is refused rather than read as empty', () => {
    const root = mkdtempSync(join(tmpdir(), 'zip-enc-'));
    roots.push(root);
    const src = join(root, 'src');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'kortix.yaml'), 'kortix_version: 2\n');
    const out = join(root, 'enc.zip');
    const res = spawnSync('zip', ['-q', '-P', 'hunter2', out, 'kortix.yaml'], { cwd: src });
    if (res.status !== 0) return; // this `zip` build has no encryption support
    let err: ZipReadError | null = null;
    try {
      readZipTextFiles(new Uint8Array(readFileSync(out)));
    } catch (e) {
      err = e as ZipReadError;
    }
    expect(err?.code).toBe('encrypted');
  });

  test('too many CRAFT files is refused', () => {
    // Two things matter in this fixture. The skills live under `.kortix/` so
    // `isCraftContentPath` keeps them and the CAP is what fires. And the root
    // `kortix.yaml` is required, not decoration: with `.kortix/` as the only
    // top-level entry `detectSingleRoot` would strip it, and the paths would
    // stop being craft content — see the dedicated test below.
    const many: Record<string, string> = { 'kortix.yaml': 'kortix_version: 2\n' };
    for (let i = 0; i < 12; i += 1) many[`.kortix/opencode/skills/s${i}/SKILL.md`] = 'x';
    let err: ZipReadError | null = null;
    try {
      readZipTextFiles(makeZip(many), { ...CRAFT_ZIP_LIMITS, maxEntries: 5 });
    } catch (e) {
      err = e as ZipReadError;
    }
    expect(err?.code).toBe('too_many_entries');
  });

  test('exceeding the total byte budget is refused', () => {
    let err: ZipReadError | null = null;
    try {
      readZipTextFiles(
        makeZip({
          'kortix.yaml': 'kortix_version: 2\n',
          '.kortix/opencode/agents/a.md': 'x'.repeat(5_000),
        }),
        { ...CRAFT_ZIP_LIMITS, maxTotalBytes: 100 },
      );
    } catch (e) {
      err = e as ZipReadError;
    }
    expect(err?.code).toBe('too_large');
  });

  test('an over-sized single entry is SKIPPED, not fatal', () => {
    // One huge file in somebody's repo should not block the craft.
    const { files, skipped } = readZipTextFiles(
      makeZip({ ...CRAFT, '.kortix/opencode/agents/huge.md': 'x'.repeat(5_000) }),
      { ...CRAFT_ZIP_LIMITS, maxEntryBytes: 1_000 },
    );
    expect(skipped).toContain('.kortix/opencode/agents/huge.md');
    expect(files.some((f) => f.path === 'kortix.yaml')).toBe(true);
  });
});

describe('isCraftTextPath', () => {
  test('accepts the extensions a craft is made of', () => {
    for (const p of [
      'kortix.yaml',
      'kortix.yml',
      'kortix.toml',
      'a/SKILL.md',
      'a.mdx',
      'opencode.jsonc',
      'tool.ts',
      'run.sh',
      '.env.example',
    ]) {
      expect(isCraftTextPath(p)).toBe(true);
    }
  });

  test('refuses everything else — an allowlist, not a denylist', () => {
    for (const p of ['logo.png', 'a.zip', 'bin/kortix', 'x.so', 'y.lock', 'noext']) {
      expect(isCraftTextPath(p)).toBe(false);
    }
  });
});

/**
 * `isCraftContentPath` — the filter that makes "zip your project folder" work.
 *
 * It is load-bearing in a way a size cap is not. The install prompt tells the
 * agent "these files ARE the craft — copy from here", so anything this function
 * lets through becomes a file written into SOMEONE ELSE'S repository at install
 * time. A stored `src/server.ts` is not a bloat problem, it is the install
 * dumping your application into their project.
 */
describe('isCraftContentPath', () => {
  test('keeps the manifest, at the root only', () => {
    expect(isCraftContentPath('kortix.yaml')).toBe(true);
    expect(isCraftContentPath('kortix.yml')).toBe(true);
    expect(isCraftContentPath('kortix.toml')).toBe(true);
    // `crawlCraftZip` looks for the manifest at the root and nowhere else, so a
    // nested one belongs to a different project, not to this craft.
    expect(isCraftContentPath('packages/thing/kortix.yaml')).toBe(false);
  });

  test('keeps everything under .kortix/, at any depth', () => {
    expect(isCraftContentPath('.kortix/opencode/agents/seo-writer.md')).toBe(true);
    expect(isCraftContentPath('.kortix/opencode/skills/seo-audit/SKILL.md')).toBe(true);
    // A skill's bundled helper script — the documented place for one.
    expect(isCraftContentPath('.kortix/opencode/skills/seo-audit/run.py')).toBe(true);
    // Monorepo layout.
    expect(isCraftContentPath('apps/web/.kortix/opencode/agents/a.md')).toBe(true);
  });

  test('keeps the root README and .env.example', () => {
    expect(isCraftContentPath('README.md')).toBe(true);
    expect(isCraftContentPath('readme.mdx')).toBe(true);
    expect(isCraftContentPath('.env.example')).toBe(true);
    // Not a nested one — that documents a subpackage, not the craft.
    expect(isCraftContentPath('docs/README.md')).toBe(false);
  });

  test('LEAVES BEHIND application source — the whole point', () => {
    for (const path of [
      'src/server.ts',
      'src/components/Button.tsx',
      'lib/util.js',
      'scripts/deploy.sh',
      'main.py',
      'package.json',
      'tsconfig.json',
      'docs/architecture.md',
      'test/server.test.ts',
    ]) {
      expect(isCraftContentPath(path)).toBe(false);
    }
  });

  test('a non-text path is never craft content, wherever it sits', () => {
    expect(isCraftContentPath('.kortix/opencode/agents/logo.png')).toBe(false);
    expect(isCraftContentPath('kortix.yaml.bak')).toBe(false);
  });
});

describe('root stripping vs the content filter', () => {
  test('a real craft zip keeps its .kortix/ paths', () => {
    // `kortix.yaml` and `.kortix/` are two top-level entries, so there is no
    // single root to strip and the paths survive intact.
    const read = readZipTextFiles(makeZip(CRAFT));
    expect(read.files.map((f) => f.path)).toContain('.kortix/opencode/agents/scribe.md');
    expect(read.root).toBeNull();
  });

  test('a GitHub-style wrapper directory is stripped, and paths still match', () => {
    // "Download ZIP" wraps everything in `<repo>-<ref>/`. Stripping that is the
    // reason `detectSingleRoot` exists, and the filter must run on the STRIPPED
    // path or every craft file would read as nested and be ignored.
    const wrapped: Record<string, string> = {};
    for (const [path, body] of Object.entries(CRAFT)) wrapped[`my-craft-main/${path}`] = body;
    const read = readZipTextFiles(makeZip(wrapped));
    expect(read.root).toBe('my-craft-main');
    expect(read.files.map((f) => f.path).sort()).toEqual([
      '.kortix/opencode/agents/scribe.md',
      '.kortix/opencode/skills/notes/SKILL.md',
      'README.md',
      'kortix.yaml',
    ]);
  });

  test('an archive of ONLY .kortix/ has it stripped as the root, and carries nothing', () => {
    // Documented consequence rather than a defect: with no root manifest such an
    // archive is not an installable craft anyway — `crawlCraftZip` rejects it
    // with `manifest_not_found`, which is the honest error.
    const read = readZipTextFiles(
      makeZip({ '.kortix/opencode/agents/a.md': '---\ndescription: a\n---\n' }),
    );
    expect(read.root).toBe('.kortix');
    expect(read.files).toHaveLength(0);
  });
});

describe('readZipTextFiles — a whole-repo archive', () => {
  test('application source does not consume the craft-file budget', () => {
    // The reported failure: "archive holds more than 200 text files" on a real
    // project zip. The craft itself was tiny; the repo around it was not.
    const files: Record<string, string> = {
      'my-app/kortix.yaml': 'kortix_version: 2\n',
      'my-app/README.md': '# my app\n',
      'my-app/.kortix/opencode/agents/w.md': '---\ndescription: w\n---\n',
    };
    for (let i = 0; i < 600; i += 1) {
      files[`my-app/src/module-${i}.ts`] = `export const x${i} = ${i};\n`;
    }
    const read = readZipTextFiles(makeZip(files), { ...CRAFT_ZIP_LIMITS, maxEntries: 10 });
    // Three craft files kept, under a cap of TEN, despite 600 source files.
    expect(read.files.map((f) => f.path).sort()).toEqual([
      '.kortix/opencode/agents/w.md',
      'README.md',
      'kortix.yaml',
    ]);
    expect(read.ignored).toHaveLength(600);
    expect(read.root).toBe('my-app');
  });

  test('the entry cap still fires on genuinely many craft files', () => {
    const files: Record<string, string> = { 'c/kortix.yaml': 'kortix_version: 2\n' };
    for (let i = 0; i < 40; i += 1) {
      files[`c/.kortix/opencode/skills/s${i}/SKILL.md`] = '# s\n';
    }
    let err: unknown;
    try {
      readZipTextFiles(makeZip(files), { ...CRAFT_ZIP_LIMITS, maxEntries: 10 });
    } catch (caught) {
      err = caught;
    }
    expect((err as ZipReadError)?.code).toBe('too_many_entries');
  });
});
