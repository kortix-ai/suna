import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Guards the loader size rule (KRTX-559, `CLAUDE.md` → Loading): the loader is
 * `KortixLoader` at its default `small` size everywhere. A bigger preset is
 * allowed only where the loader is the whole screen's content:
 * - `large` on the boot screens, the size of the 80 pt native splash mark;
 * - `medium` on the session-wake screen.
 * `customSize` (inline status glyphs in rows and tool cards) is not checked.
 */

type SourceFile = { path: string; source: string };

const MOBILE_ROOT = join(import.meta.dir, '..', '..');
const SOURCE_DIRS = ['app', 'components', 'lib', 'hooks'];

const ALLOWED_SIZES: Record<string, string> = {
  'app/index.tsx': 'large',
  'app/welcome.tsx': 'large',
  'app/+not-found.tsx': 'large',
  'components/session/SessionConnecting.tsx': 'medium',
};

export function findLoaderSizeViolations(files: SourceFile[]): string[] {
  const violations: string[] = [];
  for (const file of files) {
    for (const m of file.source.matchAll(/<KortixLoader\b[^]*?\/>/g)) {
      const size = /\bsize=(?:"([^"]*)"|'([^']*)'|\{([^}]*)\})/.exec(m[0]);
      if (!size) continue;
      const value = size[1] ?? size[2];
      if (value === 'small' || (value !== undefined && ALLOWED_SIZES[file.path] === value)) continue;
      violations.push(`${file.path}: ${size[0]} — use the default small loader (KRTX-559)`);
    }
  }
  return violations;
}

function readSourceTree(): SourceFile[] {
  const files: SourceFile[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.tsx')) files.push({ path: relative(MOBILE_ROOT, path), source: readFileSync(path, 'utf8') });
    }
  };
  for (const dir of SOURCE_DIRS) walk(join(MOBILE_ROOT, dir));
  return files;
}

describe('KortixLoader size guard', () => {
  it('allows the default, small, customSize, and the allowlisted full-screen sites', () => {
    expect(
      findLoaderSizeViolations([
        { path: 'components/a.tsx', source: '<KortixLoader />\n<KortixLoader size="small" />\n<KortixLoader customSize={16} />' },
        { path: 'app/index.tsx', source: '<KortixLoader size="large" />' },
        { path: 'components/session/SessionConnecting.tsx', source: '<KortixLoader size="medium" />' },
      ]),
    ).toEqual([]);
  });

  it('reports a bigger preset outside its allowlisted site', () => {
    expect(
      findLoaderSizeViolations([
        { path: 'components/b.tsx', source: "<View>\n  <KortixLoader\n    size=\"large\"\n    forceTheme={isDark ? 'light' : 'dark'}\n  />\n</View>" },
        { path: 'components/c.tsx', source: "<KortixLoader size={busy ? 'medium' : 'small'} />" },
        { path: 'app/index.tsx', source: '<KortixLoader size="medium" />' },
      ]),
    ).toEqual([
      'components/b.tsx: size="large" — use the default small loader (KRTX-559)',
      "components/c.tsx: size={busy ? 'medium' : 'small'} — use the default small loader (KRTX-559)",
      'app/index.tsx: size="medium" — use the default small loader (KRTX-559)',
    ]);
  });

  it('the app source tree has no violations', () => {
    const files = readSourceTree();
    expect(files.some((f) => f.path === 'components/kortix/kortix-loader.tsx')).toBe(true);
    expect(findLoaderSizeViolations(files)).toEqual([]);
  });
});
