import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

// The brand kit is one skill, `.agents/skills/kortix-brand`. Its only file with
// values is references/visual/visual-system.json. The generator turns it into
// the CSS tokens in apps/web, apps/mobile and the portable kit. These tests
// fail when a generated file drifts, when a guidance file cites a color value,
// when a relative link breaks, or when a motion utility compiles to nothing.

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const KIT = join(REPO_ROOT, '.agents/skills/kortix-brand');
const REFERENCES = join(KIT, 'references');
const GENERATOR = join(KIT, 'scripts/generate-tokens.ts');
const WEB_APP = join(REPO_ROOT, 'apps/web/src/app');

function walk(dir: string, accept: (file: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...walk(path, accept));
    else if (accept(path)) out.push(path);
  }
  return out;
}
const markdown = (file: string) => file.endsWith('.md');

/** Drop fenced and inline code, so examples do not count as links or colors. */
const withoutCode = (text: string) => text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');

describe('generated tokens', () => {
  it('generate-tokens --check exits 0 (no drift in globals.css, mobile global.css, tokens.css, fonts.css)', () => {
    let output = '';
    let status = 0;
    try {
      output = execFileSync('bun', [GENERATOR, '--check'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      const e = error as { status?: number; stdout?: string; stderr?: string };
      status = e.status ?? 1;
      output = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    }
    expect({ status, output }).toEqual({ status: 0, output: expect.stringContaining('no drift') });
  });
});

describe('kit guidance files', () => {
  const guidance = walk(REFERENCES, markdown);

  it('cite token names, never a hex, rgb, hsl or oklch color literal', () => {
    // A 3 or 4 digit all-number hex such as `#8286` is a pull request number.
    const hex = /(?<![\w&/#-])#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})\b/gi;
    const fn = /\b(?:rgba?|hsla?|oklch|oklab|lab|lch|color)\(\s*[\d.%-]/gi;
    const offenders: string[] = [];
    for (const file of guidance) {
      const lines = withoutCode(readFileSync(file, 'utf8')).split('\n');
      lines.forEach((line, i) => {
        for (const m of line.matchAll(hex)) {
          if (/^#\d{3,4}$/.test(m[0])) continue;
          offenders.push(`${relative(REPO_ROOT, file)}:${i + 1} ${m[0]}`);
        }
        for (const m of line.matchAll(fn)) offenders.push(`${relative(REPO_ROOT, file)}:${i + 1} ${m[0]}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('have no relative markdown link that fails to resolve', () => {
    const broken: string[] = [];
    for (const file of walk(KIT, markdown)) {
      const text = withoutCode(readFileSync(file, 'utf8'));
      for (const m of text.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
        const target = m[1];
        if (/^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(target)) continue;
        const path = decodeURIComponent(target.split('#')[0].split('?')[0]);
        if (!path) continue;
        const absolute = path.startsWith('/') ? join(REPO_ROOT, path) : resolve(dirname(file), path);
        if (!existsSync(absolute)) broken.push(`${relative(REPO_ROOT, file)} -> ${target}`);
      }
    }
    expect(broken).toEqual([]);
  });
});

describe('kit cross-references', () => {
  const slug = (heading: string) =>
    heading
      .replace(/`/g, '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, '')
      .trim()
      .replace(/\s/g, '-');

  it('resolve every #anchor in a relative link to a heading', () => {
    const broken: string[] = [];
    for (const file of walk(KIT, markdown)) {
      const text = withoutCode(readFileSync(file, 'utf8'));
      for (const m of text.matchAll(/\[[^\]]*\]\(([^)\s#]*)#([^)\s]+)\)/g)) {
        const [, rel, fragment] = m;
        if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(rel)) continue;
        const target = rel ? resolve(dirname(file), rel) : file;
        if (!existsSync(target) || !markdown(target)) continue;
        const headings = readFileSync(target, 'utf8')
          .replace(/```[\s\S]*?```/g, '')
          .split('\n')
          .filter((line) => /^#{1,6}\s/.test(line))
          .map((line) => slug(line.replace(/^#+\s+/, '')));
        if (!headings.includes(fragment)) broken.push(`${relative(REPO_ROOT, file)} -> ${rel}#${fragment}`);
      }
    }
    expect(broken).toEqual([]);
  });

  it('cite only decision ids that have a heading in decisions.md', () => {
    const decisions = readFileSync(join(REFERENCES, 'decisions.md'), 'utf8');
    const ids = [...decisions.matchAll(/^###\s+(D\d+[a-z]?|J-\d|K\d+|E\d+)\b/gm)].map((m) => m[1]);
    const resolved = (id: string) => ids.includes(id) || (/^[DKE]\d+$/.test(id) && ids.some((h) => h.startsWith(id)));
    const offenders: string[] = [];
    for (const file of walk(KIT, markdown)) {
      if (file.endsWith('decisions.md')) continue;
      const text = readFileSync(file, 'utf8').replace(/```[\s\S]*?```/g, '');
      text.split('\n').forEach((line, i) => {
        for (const m of line.matchAll(/(?<![\w#/-])(D\d+[a-z]?|J-\d|K\d+|E\d+)(?![\w-])/g)) {
          if (!resolved(m[1])) offenders.push(`${relative(REPO_ROOT, file)}:${i + 1} ${m[1]}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});

describe('deleted skill names', () => {
  // The kit replaced these skills. `decisions.md` keeps them as history.
  const pattern =
    '\\b(kortix-brand-guidelines|brand-guidelines|product-marketing)\\b|`comms`|the comms skill|comms §';

  it('are cited by no tracked file and no kit file except decisions.md', () => {
    let output = '';
    try {
      output = execFileSync(
        'git',
        [
          'grep', '-n', '-I', '-E', '--untracked', '-e', pattern, '--', '.',
          ':!pnpm-lock.yaml', ':!skills-lock.json', ':!tests/unit/brand-kit.test.ts',
          ':!.agents/skills/kortix-brand/references/decisions.md', ':!apps/mobile/assets',
        ],
        { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
      );
    } catch (error) {
      // git grep exits 1 when nothing matches.
      if ((error as { status?: number }).status !== 1) throw error;
    }
    expect(output.split('\n').filter(Boolean).map((l) => l.slice(0, 140))).toEqual([]);
  }, 30_000);
});

describe('motion duration utilities', () => {
  // `@tailwindcss/node` is not a direct dependency. It ships inside
  // `@tailwindcss/postcss`, which apps/web does depend on.
  function resolveCompile(): string | null {
    try {
      const postcss = realpathSync(join(REPO_ROOT, 'apps/web/node_modules/@tailwindcss/postcss'));
      return createRequire(join(postcss, 'package.json')).resolve('@tailwindcss/node');
    } catch {
      return null;
    }
  }
  const entry = resolveCompile();

  it.skipIf(!entry)(
    'duration-fast, -normal, -moderate, -slow and -slower compile to a rule',
    async () => {
      const { compile } = await import(pathToFileURL(entry as string).href);
      const css = readFileSync(join(WEB_APP, 'globals.css'), 'utf8');
      const compiler = await compile(css, { base: WEB_APP, onDependency() {} });
      const out: string = compiler.build([
        'duration-fast',
        'duration-normal',
        'duration-moderate',
        'duration-slow',
        'duration-slower',
      ]);
      const expected = { fast: 100, normal: 150, moderate: 200, slow: 300, slower: 500 };
      for (const [name, ms] of Object.entries(expected)) {
        const rule = out.match(new RegExp(`\\.duration-${name}\\s*\\{([^}]*)\\}`));
        expect(rule, `.duration-${name} emits no CSS`).not.toBeNull();
        expect(rule?.[1]).toContain(`transition-duration: ${ms}ms`);
      }
    },
    60_000
  );
});
