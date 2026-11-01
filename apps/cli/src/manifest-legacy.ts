/**
 * A local project on a legacy manifest format (`kortix_version` 1 or 2, or a
 * `kortix.toml` with no `kortix.yaml`): read it as the latest shape, and
 * convert its files for good (`kortix validate --fix`). The conversion itself
 * is `@kortix/manifest-schema` `convertLegacyManifest`; this module gives it
 * the filesystem.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import {
  type LegacyConversion,
  convertLegacyManifest,
  hasManifestImports,
  legacyFormatOf,
  parseLegacyToml,
  parseManifestText,
  renderManifest,
  splitManifestByOrigin,
} from '@kortix/manifest-schema';
import { resolveLocalManifestImports } from './manifest-imports.ts';

const SKIP = new Set(['.git', 'node_modules']);

/** Every file under `root`, repo-relative, without `.git` and `node_modules`. */
function repoPaths(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile()) out.push(relative(root, abs).split('\\').join('/'));
    }
  };
  walk(root);
  return out;
}

export interface LocalLegacyManifest {
  /** Absolute path of the legacy file: `kortix.yaml`/`kortix.yml` with `kortix_version` 1 or 2, or `kortix.toml`. */
  path: string;
  from: 1 | 2;
  /** The file as parsed, `imports:` merged. */
  raw: Record<string, unknown>;
}

/** The manifest at `path` when it is a legacy format, else null. Throws the TOML parser's syntax error. */
export function readLegacyManifest(path: string): LocalLegacyManifest | null {
  if (!existsSync(path)) return null;
  const text = readFileSync(path, 'utf8');
  if (/\.toml$/i.test(path)) return { path, from: 1, raw: parseLegacyToml(text) };
  const raw = parseManifestText(text);
  const from = legacyFormatOf(raw);
  if (!from) return null;
  return { path, from, raw: hasManifestImports(raw) ? resolveLocalManifestImports(path).raw : raw };
}

/** The project's manifest file: `kortix.yaml`, else `kortix.yml`, else a legacy `kortix.toml`. */
export function localManifestFile(root: string): string | null {
  return ['kortix.yaml', 'kortix.yml', 'kortix.toml'].map((name) => resolve(root, name)).find((path) => existsSync(path)) ?? null;
}

/** The project's manifest when it is a legacy format, else null. */
export function localLegacyManifest(root: string): LocalLegacyManifest | null {
  const path = localManifestFile(root);
  return path ? readLegacyManifest(path) : null;
}

/** Convert the local legacy project in memory. */
export function convertLocalLegacy(root: string, legacy: LocalLegacyManifest): LegacyConversion {
  return convertLegacyManifest(legacy.raw, legacy.from, relative(root, legacy.path).split('\\').join('/'), {
    paths: repoPaths(root),
    read: (path) => {
      const abs = resolve(root, path);
      return existsSync(abs) ? readFileSync(abs, 'utf8') : null;
    },
  });
}

/**
 * Write a conversion to disk and return the repo paths written or deleted. A
 * manifest split with `imports:` keeps each entry in the file that declared
 * it; the new registries go to the root.
 */
export function applyLocalLegacy(root: string, legacy: LocalLegacyManifest, conversion: LegacyConversion): string[] {
  const touched: string[] = [];
  const write = (path: string, content: string) => {
    const abs = resolve(root, path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf8');
    touched.push(path);
  };
  const rootPath = relative(root, legacy.path).split('\\').join('/');
  const rootRaw = /\.toml$/i.test(rootPath) ? null : parseManifestText(readFileSync(legacy.path, 'utf8'));
  const split = rootRaw && hasManifestImports(rootRaw)
    ? splitManifestByOrigin(resolveLocalManifestImports(legacy.path), { ...conversion.raw, imports: rootRaw.imports })
    : null;
  for (const change of conversion.changes) {
    // A split manifest is rewritten file by file below, in place.
    if (split && (change.path === rootPath || change.path === conversion.changes[0]!.path)) continue;
    if (change.action === 'delete') {
      rmSync(resolve(root, change.path), { force: true });
      touched.push(change.path);
    } else write(change.path, change.content ?? '');
  }
  split?.forEach((file, index) => {
    if (index === 0 || file.changed) write(file.path, renderManifest(file.raw, index === 0));
  });
  return touched;
}

/** The message every CLI write gives a legacy project. */
export function legacyWriteRefusal(path: string, from: 1 | 2): string {
  const what = from === 1 ? 'kortix.toml (kortix_version = 1)' : `${path} (kortix_version: 2)`;
  return `This project's manifest is ${what}, an older format. Kortix still runs it, but the CLI edits only the current format. Run \`kortix validate --fix\` to convert it, then run this command again.`;
}
