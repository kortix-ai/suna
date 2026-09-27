/**
 * Registry conformance: every tool name apps/web registers a renderer for has
 * a registered renderer on mobile.
 *
 * 1. Web side (static): read apps/web `tool/tools/register.ts`, follow each
 *    import to its tool file, and collect every `ToolRegistry.register('name', …)`
 *    literal plus the string arrays registered through
 *    `[…].forEach((n) => ToolRegistry.register(n, …))`. Comments are stripped
 *    first, so a commented-out registration does not count.
 * 2. Mobile side (runtime): import mobile `tool/tools/register.ts` for real and
 *    ask `ToolRegistry.get(name)` for every web name — the same lookup
 *    `ToolPartRenderer` uses.
 *
 * Bun cannot load `react-native` (Flow syntax) or the native modules the
 * renderers import. Step 2 therefore runs in a child `bun test` process
 * (`TOOL_REGISTRY_PROBE=1`) that walks the renderer import graph and replaces
 * every third-party module except a small pure-JS allowlist with an inert stub
 * (`mock.module`). Module mocks are process-wide in Bun, so they stay inside
 * that child and never reach the rest of the suite. Renderers only register at
 * module load; nothing renders, so the stubs are never exercised.
 */

import { describe, expect, mock, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';

const MOBILE_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const REPO_ROOT = join(MOBILE_ROOT, '..', '..');
const WEB_TOOLS_DIR = join(REPO_ROOT, 'apps/web/src/features/session/tool/tools');
const MOBILE_REGISTER = join(import.meta.dir, 'register.ts');
const PROBE_ENV = 'TOOL_REGISTRY_PROBE';
/** The child writes its result here. Bun 1.3 drops a subprocess's piped stdout when `bun test` runs in filter or whole-suite mode. */
const PROBE_OUT_ENV = 'TOOL_REGISTRY_PROBE_OUT';

// ─── Static parsing ──────────────────────────────────────────────────────────

/** Removes `//` and `/* *\/` comments; string contents are kept. */
export function stripComments(source: string): string {
  let out = '';
  let i = 0;
  let quote: string | null = null;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (quote) {
      out += ch;
      if (ch === '\\') {
        out += next ?? '';
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** Every tool name a renderer file registers: direct literals and `[…].forEach` arrays. */
export function registeredNames(source: string): string[] {
  const code = stripComments(source);
  const names: string[] = [];
  for (const m of code.matchAll(/ToolRegistry\.register\(\s*(['"])([^'"]+)\1\s*,/g)) names.push(m[2]);
  for (const m of code.matchAll(/\[([^\[\]]*)\]\s*\.forEach\(\s*\(?\s*(\w+)\s*\)?\s*=>\s*\{?\s*ToolRegistry\.register\(\s*\2\s*,/g)) {
    for (const lit of m[1].matchAll(/(['"])([^'"]+)\1/g)) names.push(lit[2]);
  }
  return names;
}

/** The `./x` side-effect imports of a register file, as file paths. */
export function registerImports(source: string, fromDir: string): string[] {
  const files: string[] = [];
  for (const m of stripComments(source).matchAll(/import\s+(['"])(\.[^'"]+)\1/g)) {
    const base = resolve(fromDir, m[2]);
    const file = [`${base}.tsx`, `${base}.ts`, base].find((c) => existsSync(c) && statSync(c).isFile());
    if (file) files.push(file);
  }
  return files;
}

/** Every tool name apps/web registers, sorted and de-duplicated. */
export function webRegisteredNames(): string[] {
  const register = join(WEB_TOOLS_DIR, 'register.ts');
  const names = new Set<string>();
  for (const file of registerImports(readFileSync(register, 'utf8'), WEB_TOOLS_DIR)) {
    for (const name of registeredNames(readFileSync(file, 'utf8'))) names.add(name);
  }
  return [...names].sort();
}

// ─── Child probe: import the mobile registry with native modules stubbed ─────

/** Pure-JS packages the renderer graph loads for real. */
const REAL_PACKAGES = /^(react|react\/.+|zustand|zustand\/.+|@kortix\/sdk|@kortix\/sdk\/.+|class-variance-authority|clsx|tailwind-merge)$/;
const CODE_FILE = /\.(tsx?|jsx?|mjs|cjs)$/;
const IMPORT_RE =
  /\b(?:import|export)\s+(?:type\s+)?([\w*{}\s,$]*?)\s*from\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|\bimport\s+['"]([^'"]+)['"]|\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function resolveLocal(fromFile: string, spec: string): string | null {
  const base = spec.startsWith('@/') ? join(MOBILE_ROOT, spec.slice(2)) : resolve(dirname(fromFile), spec);
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, join(base, 'index.ts'), join(base, 'index.tsx'), join(base, 'index.js')];
  return candidates.find((c) => existsSync(c) && statSync(c).isFile()) ?? null;
}

/** Walks local imports from `entry`: third-party specifiers with their named imports, and local non-code files. */
function collectModuleGraph(entry: string) {
  const packages = new Map<string, Set<string>>();
  const assets = new Set<string>();
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    if (!CODE_FILE.test(file)) {
      if (!file.endsWith('.json')) assets.add(file);
      return;
    }
    const source = readFileSync(file, 'utf8');
    for (const m of source.matchAll(IMPORT_RE)) {
      const spec = m[2] ?? m[3] ?? m[4] ?? m[5];
      if (spec.startsWith('.') || spec.startsWith('@/')) {
        const target = resolveLocal(file, spec);
        if (target) visit(target);
        continue;
      }
      if (REAL_PACKAGES.test(spec) || spec.startsWith('node:') || spec.startsWith('bun:')) continue;
      const names = packages.get(spec) ?? new Set<string>();
      packages.set(spec, names);
      const clause = m[1] ?? '';
      const braces = clause.match(/\{([\s\S]*)\}/);
      for (const raw of braces?.[1].split(',') ?? []) {
        const name = raw.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]?.trim();
        if (name) names.add(name);
      }
      // `import * as X`: every `X.name` the file reads.
      const namespace = clause.match(/\*\s+as\s+(\w+)/)?.[1];
      if (namespace) {
        for (const use of source.matchAll(new RegExp(`\\b${namespace}\\.(\\w+)`, 'g'))) names.add(use[1]);
      }
    }
  };
  visit(entry);
  return { packages, assets };
}

/** A value that survives any property read, call, or `new` at module load. */
function inert(): any {
  const handler: ProxyHandler<any> = {
    get: (_t, key) => (key === 'then' ? undefined : key === Symbol.toPrimitive ? () => '' : key === '__esModule' ? true : inert()),
    apply: () => inert(),
    construct: () => inert(),
  };
  return new Proxy(function stub() {}, handler);
}

/** `react-native`'s public names, read from its entry's `get Name()` accessors. */
function reactNativeNames(): string[] {
  try {
    const entry = Bun.resolveSync('react-native', MOBILE_ROOT);
    return [...readFileSync(entry, 'utf8').matchAll(/^\s+get (\w+)\(\)/gm)].map((m) => m[1]);
  } catch {
    return [];
  }
}

async function runProbe(): Promise<{ registered: number; missing: string[] }> {
  // Metro defines `__DEV__`; some modules read it at load.
  (globalThis as { __DEV__?: boolean }).__DEV__ = false;
  const { packages, assets } = collectModuleGraph(MOBILE_REGISTER);
  const rn = packages.get('react-native');
  if (rn) for (const name of reactNativeNames()) rn.add(name);
  for (const [spec, names] of packages) {
    mock.module(spec, () => {
      const exports: Record<string, unknown> = { default: inert() };
      for (const name of names) exports[name] = inert();
      return exports;
    });
  }
  for (const asset of assets) mock.module(asset, () => ({ default: 1 }));

  const { ToolRegistry } = await import('../shared/registry');
  await import('./register');
  const missing = webRegisteredNames().filter((name) => !ToolRegistry.get(name));
  return { registered: ToolRegistry.keys().length, missing };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

if (process.env[PROBE_ENV] === '1') {
  test('probe: import the mobile tool registry', async () => {
    const out = process.env[PROBE_OUT_ENV];
    if (!out) throw new Error(`${PROBE_OUT_ENV} is not set`);
    try {
      writeFileSync(out, JSON.stringify(await runProbe()));
    } catch (error) {
      writeFileSync(out, JSON.stringify({ error: error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error) }));
    }
  });
} else {
  describe('tool registry conformance — mobile registers every web tool name', () => {
    test('the web parser finds direct and forEach registrations, and ignores comments', () => {
      const source = [
        "ToolRegistry.register('a_tool', A);",
        "// ToolRegistry.register('commented', A);",
        "/* ToolRegistry.register('blocked', A); */",
        "['x-one', 'x-two'].forEach((toolName) => ToolRegistry.register(toolName, B));",
      ].join('\n');
      expect(registeredNames(source)).toEqual(['a_tool', 'x-one', 'x-two']);
    });

    test('web registers the known families (the sweep is not silently empty)', () => {
      const names = webRegisteredNames();
      expect(names.length).toBeGreaterThan(150);
      for (const name of ['bash', 'project_select', 'integration-exec', 'kortix-connectors_call', 'trigger-resume']) {
        expect(names).toContain(name);
      }
    });

    test('every web-registered tool name resolves to a mobile renderer', () => {
      const dir = mkdtempSync(join(tmpdir(), 'tool-registry-probe-'));
      const out = join(dir, 'result.json');
      try {
        const child = Bun.spawnSync([process.execPath, 'test', `./${relative(MOBILE_ROOT, import.meta.path)}`], {
          cwd: MOBILE_ROOT,
          env: { ...process.env, [PROBE_ENV]: '1', [PROBE_OUT_ENV]: out },
          stdout: 'ignore',
          stderr: 'ignore',
        });
        if (!existsSync(out)) throw new Error(`registry probe wrote no result (exit ${child.exitCode})`);
        const result = JSON.parse(readFileSync(out, 'utf8')) as { registered?: number; missing?: string[]; error?: string };
        if (result.error) throw new Error(`registry probe failed to import the mobile registry:\n${result.error}`);
        expect(result.registered).toBeGreaterThan(0);
        expect(result.missing).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 60_000);
  });
}
