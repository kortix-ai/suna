import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import {
  type ManifestFormat,
  type ManifestImportReaderSync,
  type ResolvedManifest,
  parseManifestText,
  resolveManifestImportsSync,
} from '@kortix/manifest-schema';

/**
 * `imports:` for the manifest in a working tree. The same resolver the API
 * runs over git (`resolveManifestImportsSync`), backed by the filesystem, so
 * `kortix validate` / `kortix ship` see the merged document the platform will
 * run — and report a broken import before a push does.
 *
 * Import paths are repository-relative. The manifest sits at the repository
 * root, so they resolve against the manifest's own directory.
 */

const SKIPPED_DIRS = new Set(['.git', 'node_modules']);

function toRepoPath(root: string, abs: string): string {
  return relative(root, abs).split(sep).join('/');
}

function walk(root: string, dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) walk(root, abs, out);
    } else if (entry.isFile()) {
      out.push(toRepoPath(root, abs));
    }
  }
}

export function localImportReader(root: string): ManifestImportReaderSync {
  return {
    list(path) {
      const abs = resolve(root, path);
      if (!existsSync(abs)) return [];
      if (statSync(abs).isFile()) return [{ path: toRepoPath(root, abs) }];
      const found: string[] = [];
      walk(root, abs, found);
      return found.map((p) => ({ path: p }));
    },
    read(path) {
      return readFileSync(resolve(root, path), 'utf8');
    },
  };
}

/**
 * Parse `manifestFile` and resolve its imports. `raw` is the merged document;
 * `files`/`origins` name the file each entry is declared in. Throws the
 * parser's syntax error for the root, `ManifestImportError` for an import.
 */
export function resolveLocalManifestImports(
  manifestFile: string,
  format: ManifestFormat,
): ResolvedManifest {
  const root = dirname(manifestFile);
  const raw = parseManifestText(readFileSync(manifestFile, 'utf8'), format);
  const rootSource = { path: toRepoPath(root, manifestFile), raw };
  // Imports are a kortix.yaml feature, exactly as in the API: a TOML (v1)
  // manifest is read as the single file it is.
  if (format !== 'yaml') {
    return {
      raw,
      files: [rootSource],
      origins: { triggers: {}, connectors: {}, agents: {}, apps: {} },
    };
  }
  return resolveManifestImportsSync(rootSource, localImportReader(root));
}
