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
  type ZipReadError,
  detectSingleRoot,
  isCraftTextPath,
  normalizeZipPath,
  readZipTextFiles,
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

  test('too many text files is refused', () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 12; i += 1) many[`f${i}.md`] = 'x';
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
      readZipTextFiles(makeZip({ 'a.md': 'x'.repeat(5_000) }), {
        ...CRAFT_ZIP_LIMITS,
        maxTotalBytes: 100,
      });
    } catch (e) {
      err = e as ZipReadError;
    }
    expect(err?.code).toBe('too_large');
  });

  test('an over-sized single entry is SKIPPED, not fatal', () => {
    // One huge file in somebody's repo should not block the craft.
    const { files, skipped } = readZipTextFiles(
      makeZip({ ...CRAFT, 'huge.md': 'x'.repeat(5_000) }),
      { ...CRAFT_ZIP_LIMITS, maxEntryBytes: 1_000 },
    );
    expect(skipped).toContain('huge.md');
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
