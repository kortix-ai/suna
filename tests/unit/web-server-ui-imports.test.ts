import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// A server module (an apps/web file a route reaches before any 'use client' boundary) may
// render a client component from @kortix/ui, but it must not call a function exported from
// a 'use client' file: on the server that name is a client reference, and the call throws
// "Attempted to call X() from the server". 2026-10-20: '@kortix/ui/i18n' carried 'use client',
// so localizeUiCatalog() in lib/seo/metadata.ts turned 10 marketing and changelog pages into
// the error page. A component (PascalCase) is allowed; any other value is not.

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const WEB_SRC = join(REPO_ROOT, 'apps/web/src');
const UI = join(REPO_ROOT, 'packages/ui');
const EXPORTS: Record<string, unknown> = JSON.parse(readFileSync(join(UI, 'package.json'), 'utf8')).exports;
const EXTS = ['', '.ts', '.tsx', '/index.ts', '/index.tsx'];
const ROUTE_FILE = /\/(page|layout|route|template|not-found|default|opengraph-image|twitter-image|sitemap|robots|manifest)\.tsx?$/;
const IMPORT = /(?:^|\n)\s*(import|export)\s+(type\s+)?([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g;

const sourceCache = new Map<string, string>();
const read = (file: string) => {
  if (!sourceCache.has(file)) sourceCache.set(file, readFileSync(file, 'utf8'));
  return sourceCache.get(file)!;
};
const isClient = (file: string) => /^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*['"]use client['"]/.test(read(file));
const resolveFile = (base: string) => EXTS.map((ext) => base + ext).find((p) => existsSync(p) && /\.tsx?$/.test(p));

function resolve(from: string, specifier: string): string | undefined {
  if (specifier.startsWith('@/')) return resolveFile(join(WEB_SRC, specifier.slice(2)));
  if (specifier.startsWith('.')) return resolveFile(join(dirname(from), specifier));
  if (specifier === '@kortix/ui' || specifier.startsWith('@kortix/ui/')) {
    const target = EXPORTS[`.${specifier.slice('@kortix/ui'.length)}`];
    return typeof target === 'string' && /\.tsx?$/.test(target) ? join(UI, target) : undefined;
  }
  return undefined;
}

type Binding = { name: string; imported: string; specifier: string; typeOnly: boolean };
function bindings(file: string): Binding[] {
  const out: Binding[] = [];
  for (const [, , typeKw, clause, specifier] of read(file).matchAll(IMPORT)) {
    const braces = clause!.match(/\{([^}]*)\}/)?.[1];
    for (const part of braces?.split(',') ?? []) {
      const m = part.trim().match(/^(type\s+)?([\w$]+)(?:\s+as\s+([\w$]+))?$/);
      if (m) out.push({ imported: m[2]!, name: m[3] ?? m[2]!, specifier: specifier!, typeOnly: !!typeKw || !!m[1] });
    }
    if (/^\*/.test(clause!.trim())) out.push({ imported: '*', name: '*', specifier: specifier!, typeOnly: !!typeKw });
  }
  return out;
}

/** True when `name`, read from `file`, is defined in or re-exported through a 'use client' file. */
function isClientReference(file: string, name: string, seen = new Set<string>()): boolean {
  if (seen.has(file)) return false;
  seen.add(file);
  if (isClient(file)) return true;
  for (const b of bindings(file)) {
    if (b.typeOnly) continue;
    const next = resolve(file, b.specifier);
    if (!next) continue;
    if (b.name === name && new RegExp(`export\\s*\\{[^}]*\\b${name}\\b`).test(read(file))) {
      if (isClientReference(next, b.imported, seen)) return true;
    }
    if (b.imported === '*' && new RegExp(`export\\s*\\*\\s*from\\s*['"]${b.specifier}['"]`).test(read(file))) {
      if (isClientReference(next, name, seen)) return true;
    }
  }
  return false;
}

export function serverCallsIntoClient(): string[] {
  const routes = execFileSync('git', ['ls-files', '--', 'apps/web/src/app'], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((f) => ROUTE_FILE.test(`/${f}`))
    .map((f) => join(REPO_ROOT, f));
  const problems = new Set<string>();
  const queue = routes.filter((f) => !isClient(f));
  const visited = new Set(queue);
  while (queue.length) {
    const file = queue.pop()!;
    for (const b of bindings(file)) {
      if (b.typeOnly) continue;
      const target = resolve(file, b.specifier);
      if (!target) continue;
      if (target.startsWith(WEB_SRC) && !isClient(target) && !visited.has(target)) {
        visited.add(target);
        queue.push(target);
      }
      const isUi = b.specifier === '@kortix/ui' || b.specifier.startsWith('@kortix/ui/');
      const isComponent = /^[A-Z][a-z]/.test(b.imported) && !/^[A-Z0-9_]+$/.test(b.imported);
      if (isUi && b.imported !== '*' && !isComponent && isClientReference(target, b.imported)) {
        problems.add(`${relative(REPO_ROOT, file)}: ${b.imported} from '${b.specifier}'`);
      }
    }
  }
  return [...problems].sort();
}

describe('apps/web server modules call no @kortix/ui client reference', () => {
  it('every value a server module imports from @kortix/ui is a component or comes from a non-client file', () => {
    expect(serverCallsIntoClient()).toEqual([]);
  });
});
