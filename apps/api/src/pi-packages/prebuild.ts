/**
 * Pre-build installed pi packages into files the sandbox imports natively.
 *
 * jiti compiles every extension on each fresh sandbox (rpiv-todo ~316 ms,
 * pi-web-access ~1.4 s in the sandbox, measured), and unpacking a full
 * `node_modules` is thousands of files. Instead, each extension entry becomes
 * ONE ESM file with its dependencies inlined. Imports of the modules pi hands
 * every extension (`PI_HOST_MODULES`, pi's own virtual-module list) read a
 * registry the daemon fills from its binary, so the file has no bare import left.
 *
 * Output (`outDir`): `manifest.json` plus `packages/<name>/`, the package's own
 * files with each pre-built entry next to its source entry, so relative file
 * reads from the entry resolve the same way. The object is on the boot path
 * (1.9 MB took 1.5 s from us-west-2 to an Amsterdam box), so it leaves out what
 * runtime never reads: `node_modules`, media, type declarations, source maps,
 * the root README/CHANGELOG, and the code files an entry inlined.
 * A package this cannot pre-build is listed with a reason; the sandbox loads it
 * from the `node_modules` fallback bundle instead.
 *
 * Runs as its own process (`bun prebuild.ts <node_modules> <outDir> <name>...`):
 * a hostile or huge package can stall or crash it without touching the API.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';

/** The modules pi supplies to extensions (pi-coding-agent `VIRTUAL_MODULES`). */
export const PI_HOST_MODULES = [
  'typebox',
  'typebox/compile',
  'typebox/value',
  '@sinclair/typebox',
  '@sinclair/typebox/compile',
  '@sinclair/typebox/value',
  '@earendil-works/pi-agent-core',
  '@earendil-works/pi-tui',
  '@earendil-works/pi-ai',
  '@earendil-works/pi-ai/compat',
  '@earendil-works/pi-ai/oauth',
  '@earendil-works/pi-ai/providers/all',
  '@earendil-works/pi-coding-agent',
  '@mariozechner/pi-agent-core',
  '@mariozechner/pi-tui',
  '@mariozechner/pi-ai',
  '@mariozechner/pi-ai/compat',
  '@mariozechner/pi-ai/oauth',
  '@mariozechner/pi-ai/providers/all',
  '@mariozechner/pi-coding-agent',
] as const;

export const PREBUILT_FORMAT = 'pi-packages-v3';
const MEDIA = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.mp4', '.webm', '.mov', '.mp3', '.wav']);
const CODE = /\.(ts|js|mjs|cts|mts|cjs)$/;
/** Never read at runtime: type declarations and source maps. */
const BUILD_ONLY = /\.(d\.[cm]?ts|map)$/;
const ROOT_DOCS = /^(readme|changelog)(\.|$)/i;
const INLINED_CODE = /\.(ts|js|mjs|cts|mts|cjs|tsx|jsx)$/;

export type PrebuiltPackage =
  | { name: string; version: string; dir: string; extensions: string[] }
  | { name: string; version: string; fallback: string };

export interface PrebuiltManifest {
  format: typeof PREBUILT_FORMAT;
  packages: PrebuiltPackage[];
}

/** Directory entry → pi's `resolveExtensionEntries`: its package.json `pi.extensions`, else index.ts, else index.js. */
function directoryEntries(dir: string): string[] | null {
  const manifest = readPiManifest(join(dir, 'package.json'));
  if (manifest?.extensions?.length) {
    const entries = manifest.extensions.map((entry) => resolve(dir, entry)).filter((path) => existsSync(path));
    if (entries.length) return entries;
  }
  for (const index of ['index.ts', 'index.js']) if (existsSync(join(dir, index))) return [join(dir, index)];
  return null;
}

function readPiManifest(path: string): { extensions?: string[] } | null {
  try {
    const pkg = JSON.parse(readFileSync(path, 'utf8')) as { pi?: { extensions?: unknown } };
    const extensions = pkg.pi?.extensions;
    return Array.isArray(extensions) ? { extensions: extensions.filter((e): e is string => typeof e === 'string') } : pkg.pi ? {} : null;
  } catch {
    return null;
  }
}

/**
 * The extension entry files pi would load from a package, for the shapes this
 * mirrors exactly: plain `pi.extensions` files or directories, or the
 * conventional `extensions/` folder (its .ts/.js files and subfolder entries).
 * Globs and override patterns return null: that package takes the fallback.
 */
export function extensionEntries(packageDir: string): string[] | null {
  const manifest = readPiManifest(join(packageDir, 'package.json'));
  // A `pi` field decides alone: no `extensions` key means no extensions (pi's collectPackageResources).
  if (manifest) {
    const entries = manifest.extensions ?? [];
    if (entries.some((entry) => /[*?[\]{}!]/.test(entry) || /^[+-]/.test(entry))) return null;
    const found: string[] = [];
    for (const entry of entries) {
      const path = resolve(packageDir, entry);
      if (!existsSync(path)) continue;
      if (statSync(path).isFile()) {
        if (CODE.test(path)) found.push(path);
        continue;
      }
      const inside = autoEntries(path);
      if (!inside) return null;
      found.push(...inside);
    }
    return found;
  }
  const conventional = join(packageDir, 'extensions');
  return existsSync(conventional) ? autoEntries(conventional) : [];
}

/**
 * pi's `collectAutoExtensionEntries`: the folder's own entry, else its .ts/.js
 * files and subfolder entries. Ignore files are pi's to apply: null (fallback).
 */
function autoEntries(dir: string): string[] | null {
  const own = directoryEntries(dir);
  if (own) return own;
  if (['.gitignore', '.ignore', '.fdignore'].some((file) => existsSync(join(dir, file)))) return null;
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith('.') && entry.name !== 'node_modules')
    .flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isFile()) return /\.(ts|js)$/.test(entry.name) ? [path] : [];
      if (entry.isDirectory()) return directoryEntries(path) ?? [];
      return [];
    });
}

function copyOwnFiles(from: string, to: string): void {
  cpSync(from, to, {
    recursive: true,
    filter: (source) => {
      const name = basename(source);
      if (name === 'node_modules' || name === '.git' || BUILD_ONLY.test(name)) return false;
      if (dirname(source) === from && ROOT_DOCS.test(name)) return false;
      return !MEDIA.has(extname(name).toLowerCase());
    },
  });
}

/**
 * One entry → one self-contained ESM file beside it (`<entry>.kortix.js`).
 * Returns every file the bundler loaded. Minified without renaming: an
 * extension may read a class or function name, and the API image's Bun 1.2.23
 * ignores `keepNames` (measured) and has no `metafile`.
 * Every loaded file must resolve (symlinks included) inside `installRoot`: a
 * `../`, absolute or symlinked import of an API-host file would ship its
 * contents in the bundle. Such a package fails here and takes the fallback.
 */
async function buildEntry(entry: string, outFile: string, installRoot: string): Promise<string[]> {
  const exact = new Set<string>(PI_HOST_MODULES);
  const loaded: string[] = [];
  const result = await Bun.build({
    entrypoints: [entry],
    outdir: dirname(outFile),
    naming: basename(outFile),
    target: 'bun',
    format: 'esm',
    minify: { whitespace: true, syntax: true },
    plugins: [
      {
        name: 'pi-host-modules',
        setup(build) {
          build.onResolve({ filter: /^(typebox|@sinclair\/typebox|@(earendil-works|mariozechner)\/pi-)/ }, (args) =>
            exact.has(args.path) ? { path: args.path, namespace: 'pi-host' } : undefined,
          );
          build.onLoad({ filter: /.*/, namespace: 'pi-host' }, (args) => ({
            contents: `module.exports = globalThis.__kortixPiHost[${JSON.stringify(args.path)}];`,
            loader: 'js',
          }));
          // Records the file, then Bun's own loader handles it.
          build.onLoad({ filter: /.*/, namespace: 'file' }, (args) => {
            if (relative(installRoot, realpathSync(args.path)).startsWith('..')) {
              throw new Error(`${args.path} is outside the package install tree`);
            }
            loaded.push(args.path);
            return undefined as never;
          });
        },
      },
    ],
  });
  if (!result.success) throw new Error(result.logs.map(String).join('\n').slice(0, 800) || 'bundling failed');
  return loaded;
}

/** Remove the package's own code files that an entry inlined; other files may be read at runtime. */
function removeInlinedCode(source: string, target: string, loaded: Iterable<string>): void {
  const real = realpathSync(source);
  for (const path of loaded) {
    if (!INLINED_CODE.test(path)) continue;
    const rel = relative(real, realpathSync(path));
    if (rel.startsWith('..')) continue;
    rmSync(join(target, rel), { force: true });
  }
}

export async function prebuildPackages(nodeModules: string, names: readonly string[], outDir: string): Promise<PrebuiltManifest> {
  const packages: PrebuiltPackage[] = [];
  const installRoot = realpathSync(nodeModules);
  for (const name of names) {
    const source = join(nodeModules, name);
    const version = (JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')) as { version: string }).version;
    const entries = extensionEntries(source);
    if (!entries) {
      packages.push({ name, version, fallback: 'extension paths use globs or overrides' });
      continue;
    }
    const dir = join('packages', name);
    const target = join(outDir, dir);
    try {
      copyOwnFiles(source, target);
      const built: string[] = [];
      const loaded = new Set<string>();
      for (const entry of entries) {
        const rel = relative(source, entry);
        const out = join(target, `${rel}.kortix.js`);
        mkdirSync(dirname(out), { recursive: true });
        for (const path of await buildEntry(entry, out, installRoot)) loaded.add(path);
        built.push(join(dir, `${rel}.kortix.js`));
      }
      removeInlinedCode(source, target, loaded);
      packages.push({ name, version, dir, extensions: built });
    } catch (err) {
      // Bun.build throws an AggregateError whose `errors` carry the reasons.
      const reasons = (err as { errors?: unknown[] }).errors?.map(String) ?? [(err as Error).message];
      packages.push({ name, version, fallback: `pre-build failed: ${reasons.join('; ').slice(0, 500)}` });
    }
  }
  const manifest: PrebuiltManifest = { format: PREBUILT_FORMAT, packages };
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

if (import.meta.main) {
  const [nodeModules, outDir, ...names] = process.argv.slice(2);
  if (!nodeModules || !outDir || names.length === 0) {
    process.stderr.write('usage: bun prebuild.ts <node_modules> <outDir> <package>...\n');
    process.exit(2);
  }
  mkdirSync(outDir, { recursive: true });
  const manifest = await prebuildPackages(nodeModules, names, outDir);
  process.stdout.write(`${JSON.stringify(manifest)}\n`);
}
