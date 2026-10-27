/**
 * Test-graph mocking for the mobile component render tests.
 *
 * Mirrors `drawer-render.test.tsx`'s approach — parse the import specifiers of
 * a component's (transitive) local graph and `mock.module` every one that is
 * not in the caller's `real` allowlist, preferring the caller's `fakes` for
 * specifiers that need more than an empty stub. This keeps the heavy native
 * ecosystem (`react-native-svg`, `@gorhom/bottom-sheet`, `react-native-webview`,
 * `@rn-primitives/*`, expo routers) out of a bun test while the tested logic —
 * the SDK, TanStack Query, the session stores — stays real.
 *
 * Local modules are mocked by their resolved absolute path, so a fake keyed
 * once (`components/session/tool/shared/navigation`) covers every spelling the
 * graph uses (`./navigation`, `../shared/navigation`).
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mock } from 'bun:test';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js', '/index.tsx', '/index.ts'];

export type Fakes = Record<string, Record<string, unknown>>;

const resolveLocal = (spec: string, fromFile: string): string | null => {
  const base = spec.startsWith('@/')
    ? join(ROOT, spec.slice(2))
    : spec.startsWith('.')
      ? join(dirname(fromFile), spec)
      : null;
  if (!base) return null;
  for (const ext of EXTENSIONS) if (existsSync(base + ext)) return base + ext;
  return null;
};

/** The mock key for a fakes entry: absolute path for a local module, else the package specifier. */
const fakeKey = (key: string): string => {
  const asRoot = join(ROOT, key);
  for (const ext of EXTENSIONS) if (existsSync(asRoot + ext)) return asRoot + ext;
  const local = resolveLocal(key, join(ROOT, 'index'));
  return local ?? key;
};

/**
 * Every module specifier a graph file pulls, with the names it binds. `stop`
 * lists the resolved paths of `real` modules: their own dependency trees are
 * their responsibility and are neither walked nor mocked.
 */
const importsOf = (file: string, stop: Set<string>): Map<string, { local: string | null; names: Set<string> }> => {
  const specs = new Map<string, { local: string | null; names: Set<string> }>();
  const seen = new Set<string>();
  const walk = (current: string, shallow = false): void => {
    if (seen.has(current)) return;
    seen.add(current);
    const source = readFileSync(current, 'utf8');
    const record = (spec: string, names: string[]): void => {
      // Key by the resolved local path so every spelling of one module
      // (`@/x/y`, `./y`, `../x/y`) merges its bound names into one entry.
      const local = resolveLocal(spec, current);
      const key = local ?? spec;
      const entry = specs.get(key) ?? { local, names: new Set<string>() };
      for (const name of names) entry.names.add(name);
      specs.set(key, entry);
      if (local) walk(local, stop.has(local));
    };
    for (const match of source.matchAll(
      /(?:import|export)\s+(?:type\s+)?(?:[\w$]+\s*,\s*)?(?:\{([^}]*)\}|(?:\*\s+as\s+[\w$]+)|(?:[\w$]+))\s*from\s*['"]([^'"]+)['"]/g,
    )) {
      const names = (match[1] ?? '')
        .split(',')
        .map((part) => part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim())
        .filter((name) => name.length > 0);
      record(match[2], names);
    }
    for (const match of source.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) record(match[1], ['default']);
    // A stopped (`real`) module still binds every name it imports — the mock
    // it resolves to must carry them, or loading it throws. Record the names;
    // do not descend into its dependency tree.
    if (shallow) return;
  };
  walk(file);
  return specs;
};

/**
 * Mock every non-`real` specifier the entry files (transitively) import.
 * `fakes` keys are repo-root-relative module paths (`components/ui/text`) or
 * package names; every other imported name gets an empty stub. Specifiers in
 * `real` stay untouched.
 */
export async function mockGraph(entries: string[], real: string[], fakes: Fakes = {}): Promise<void> {
  const Empty = () => null;
  const skip = new Set([...real, 'react', 'bun:test']);
  const skipResolved = new Set<string>();
  for (const entry of entries) {
    const entryFile = resolveLocal(entry, join(ROOT, 'index')) ?? join(ROOT, entry);
    for (const spec of skip) {
      const local = resolveLocal(spec, entryFile) ?? resolveLocal(spec, join(ROOT, 'index'));
      if (local) skipResolved.add(local);
      // Root-relative spellings (`components/ui/text`) resolve like a fakes key.
      const asRoot = join(ROOT, spec);
      for (const ext of EXTENSIONS) if (existsSync(asRoot + ext)) skipResolved.add(asRoot + ext);
    }
  }
  const fakeByResolved = new Map<string, Record<string, unknown>>();
  for (const [key, values] of Object.entries(fakes)) fakeByResolved.set(fakeKey(key), values);
  // Explicit fakes register up front: a fake for a module no walked file
  // imports (a native subpath a leaf depends on) must still apply. The walk
  // below re-registers recorded specs with the auto-filled names merged in;
  // same keys, same values.
  for (const [target, values] of fakeByResolved) mock.module(target, () => ({ ...values }));

  // Auto-mocks must survive other test files in the same bun process: a later
  // file may load a mocked `@kortix/*` package for real through its own real
  // modules, so every export has to be present, not just the names one
  // graph's walk happened to see. Our packages are pure TypeScript, so load
  // the actual exports and mock with the whole surface; anything that fails
  // to load (native code) falls back to empty stubs for the recorded names.
  const packageValues = new Map<string, Record<string, unknown>>();
  const localSpecs = new Map<string, Set<string>>();
  for (const entry of entries) {
    const file = resolveLocal(entry, join(ROOT, 'index')) ?? join(ROOT, entry);
    for (const [key, { local, names }] of importsOf(file, skipResolved)) {
      if (!local) {
        if (skip.has(key) || packageValues.has(key)) continue;
        let values: Record<string, unknown> = { default: Empty };
        if (key.startsWith('@kortix/')) {
          // Our packages are pure TypeScript: mock with the actual export
          // surface so a later test file loading the package through its own
          // real modules still finds every name. Native code falls back to
          // empty stubs for the recorded names.
          try {
            const actual = await import(key);
            values = { ...(actual as Record<string, unknown>) };
          } catch {
            // Native or unloadable: fall through to the empty stubs.
          }
        }
        const provided = fakeByResolved.get(key) ?? {};
        for (const name of names) if (!(name in provided)) values[name] = values[name] ?? Empty;
        packageValues.set(key, { ...values, ...provided });
      } else if (!skipResolved.has(local)) {
        const set = localSpecs.get(local) ?? new Set<string>();
        for (const name of names) set.add(name);
        localSpecs.set(local, set);
      }
    }
  }
  for (const [spec, values] of packageValues) mock.module(spec, () => ({ ...values }));
  for (const [local, names] of localSpecs) {
    const provided = fakeByResolved.get(local) ?? {};
    const values: Record<string, unknown> = {};
    for (const name of names) if (!(name in provided)) values[name] = Empty;
    mock.module(local, () => ({ ...values, ...provided }));
  }
}
