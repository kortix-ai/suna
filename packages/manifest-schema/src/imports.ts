/**
 * Manifest imports — split one `kortix.yaml` across several YAML files.
 *
 *     kortix_version: 2
 *     imports:
 *       - .kortix/triggers/          # a directory: every .yaml/.yml under it
 *       - .kortix/agents.yaml        # a single file
 *
 * An imported file declares any of the four COLLECTIONS — `triggers`,
 * `connectors`, `agents`, `apps` — and may itself carry `imports:` (nesting).
 * Everything else (`kortix_version`, `default_agent`, `project`, `sandbox`,
 * `env`, …) stays in the root file, so there is exactly one place that answers
 * "which agent is the default" or "which image boots".
 *
 * The rules, all of them:
 *   - Paths are repository-relative. No `..`, no absolute paths, no globs.
 *   - A directory import expands to every `.yaml`/`.yml` below it, sorted by path.
 *   - Entries merge in order: the importing file first, then its imports as listed.
 *   - One name, one file. A trigger/connector slug or agent/app name declared in
 *     two files is an error that names both — never a silent override.
 *   - A file reachable twice merges once. A cycle is an error.
 *
 * This module is pure: the caller supplies a `ManifestImportReader` (git
 * ls-tree/show in the API, the filesystem in the CLI). `resolveManifestImports`
 * returns the merged document every existing parser/validator already
 * understands, plus the origin of each entry. `splitManifestByOrigin` is the
 * inverse the write path uses, so an edit to an imported entry is committed to
 * the file that declares it instead of being flattened into the root.
 */

import { parseManifestText } from './format';

export const MANIFEST_IMPORTS_KEY = 'imports';

/** List collections; entries are identified by `slug`. */
export const IMPORTABLE_LIST_KEYS = ['triggers', 'connectors'] as const;
/** Map collections; entries are identified by their key. */
export const IMPORTABLE_MAP_KEYS = ['agents', 'apps'] as const;

export type ImportableKey =
  | (typeof IMPORTABLE_LIST_KEYS)[number]
  | (typeof IMPORTABLE_MAP_KEYS)[number];

/** Top-level keys that must stay in the root manifest. */
export const ROOT_ONLY_KEYS = [
  'kortix_version',
  'default_agent',
  'runtime',
  'project',
  'env',
  'opencode',
  'sandbox',
  'policy',
  'policies',
] as const;

export const MAX_IMPORT_DEPTH = 8;
export const MAX_IMPORT_FILES = 200;

const YAML_FILE_RE = /\.ya?ml$/i;

export class ManifestImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManifestImportError';
  }
}

export interface ManifestImportReader {
  /** Every file at `path` (a file) or below it (a directory), with its blob
   *  revision when the backing store has one. Empty when nothing matches. */
  list(path: string): Promise<Array<{ path: string; revision?: string | null }>>;
  /** The UTF-8 text of one file previously returned by `list`. */
  read(path: string): Promise<string>;
}

/** The same contract over a synchronous store (the CLI's working tree). */
export interface ManifestImportReaderSync {
  list(path: string): Array<{ path: string; revision?: string | null }>;
  read(path: string): string;
}

export interface ManifestSourceFile {
  path: string;
  raw: Record<string, unknown>;
  revision?: string | null;
}

/** For each collection: entry id (slug / map key) → path of the declaring file. */
export type ManifestOrigins = Record<ImportableKey, Record<string, string>>;

export interface ResolvedManifest {
  /** The merged document. `imports` is kept as the root declared it. */
  raw: Record<string, unknown>;
  /** The root file first, then every imported file in merge order. */
  files: ManifestSourceFile[];
  origins: ManifestOrigins;
}

export interface SplitManifestFile {
  path: string;
  raw: Record<string, unknown>;
  revision?: string | null;
  /** False when `raw` is deep-equal to what was read — nothing to commit. */
  changed: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** True when the manifest declares a non-empty `imports` key of any shape. */
export function hasManifestImports(raw: Record<string, unknown>): boolean {
  const value = raw[MANIFEST_IMPORTS_KEY];
  return value !== undefined && value !== null;
}

/**
 * The JSON Schema `pattern` for one import path. Kept beside
 * `normalizeImportPath` because the two must accept exactly the same strings
 * (the conformance test enforces it).
 */
export const IMPORT_PATH_PATTERN =
  '^(?![/\\s])(?!.*(?:^|/)\\.{1,2}(?:/|$))(?!.*//)[^\\\\*?\\[\\]{}]*[^\\\\*?\\[\\]{}\\s/]/?$';

const IMPORT_PATH_RE = new RegExp(IMPORT_PATH_PATTERN);

/**
 * Normalize one import path, or return null when it is not a plain
 * repository-relative path. One trailing `/` (directory) is dropped.
 */
export function normalizeImportPath(value: unknown): string | null {
  if (typeof value !== 'string' || !IMPORT_PATH_RE.test(value)) return null;
  return value.replace(/\/$/, '');
}

function declaredImports(file: string, raw: Record<string, unknown>): string[] {
  if (!hasManifestImports(raw)) return [];
  const value = raw[MANIFEST_IMPORTS_KEY];
  if (!Array.isArray(value)) {
    throw new ManifestImportError(`${file}: \`imports\` must be a list of paths`);
  }
  return value.map((entry) => {
    const normalized = normalizeImportPath(entry);
    if (!normalized) {
      throw new ManifestImportError(
        `${file}: import ${JSON.stringify(entry)} must be a repository-relative path to a .yaml/.yml file or a directory (no "..", no absolute path, no glob)`,
      );
    }
    return normalized;
  });
}

function emptyOrigins(): ManifestOrigins {
  return { triggers: {}, connectors: {}, agents: {}, apps: {} };
}

/** Entries of one collection in one file, as [id, value] pairs. Entries without
 *  a usable id (a list entry with no string `slug`) get a null id: they still
 *  merge — the ordinary validator reports them — but cannot be tracked. */
function collectionEntries(
  file: string,
  key: ImportableKey,
  value: unknown,
): Array<[string | null, unknown]> {
  if (value === undefined || value === null) return [];
  if ((IMPORTABLE_LIST_KEYS as readonly string[]).includes(key)) {
    if (!Array.isArray(value)) {
      throw new ManifestImportError(`${file}: \`${key}\` must be a list`);
    }
    return value.map((entry) => [
      isPlainObject(entry) && typeof entry.slug === 'string' ? entry.slug : null,
      entry,
    ]);
  }
  if (!isPlainObject(value)) {
    throw new ManifestImportError(`${file}: \`${key}\` must be a map`);
  }
  return Object.entries(value);
}

const ALL_IMPORTABLE_KEYS: readonly ImportableKey[] = [
  ...IMPORTABLE_LIST_KEYS,
  ...IMPORTABLE_MAP_KEYS,
];

/**
 * Resolve `imports:` for a parsed root manifest. A root without `imports`
 * returns immediately and never calls the reader, so projects that do not use
 * the feature pay nothing.
 */
export function resolveManifestImportsSync(
  root: ManifestSourceFile,
  reader: ManifestImportReaderSync,
): ResolvedManifest {
  const files: ManifestSourceFile[] = [root];
  const origins = emptyOrigins();
  if (!hasManifestImports(root.raw)) {
    for (const key of ALL_IMPORTABLE_KEYS) {
      for (const [id] of safeEntries(root.path, key, root.raw[key])) {
        if (id !== null) origins[key][id] = root.path;
      }
    }
    return { raw: root.raw, files, origins };
  }

  const lists: Record<string, unknown[]> = {};
  const maps: Record<string, Record<string, unknown>> = {};
  const visited = new Set<string>([root.path]);

  const mergeFile = (file: ManifestSourceFile) => {
    for (const key of ALL_IMPORTABLE_KEYS) {
      for (const [id, entry] of collectionEntries(file.path, key, file.raw[key])) {
        if (id !== null) {
          const declaredIn = origins[key][id];
          if (declaredIn !== undefined && declaredIn !== file.path) {
            throw new ManifestImportError(
              `${key} "${id}" is declared in both ${declaredIn} and ${file.path} — one name, one file`,
            );
          }
          origins[key][id] = file.path;
        }
        if ((IMPORTABLE_LIST_KEYS as readonly string[]).includes(key)) {
          (lists[key] ??= []).push(entry);
        } else if (id !== null) {
          (maps[key] ??= {})[id] = entry;
        }
      }
    }
  };

  const visit = (file: ManifestSourceFile, stack: string[]): void => {
    mergeFile(file);
    for (const importPath of declaredImports(file.path, file.raw)) {
      const listed = reader
        .list(importPath)
        .filter((entry) => YAML_FILE_RE.test(entry.path))
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      if (listed.length === 0) {
        throw new ManifestImportError(
          `${file.path}: import "${importPath}" matches no .yaml or .yml file`,
        );
      }
      for (const entry of listed) {
        if (stack.includes(entry.path)) {
          const cycle = [...stack.slice(stack.indexOf(entry.path)), entry.path];
          throw new ManifestImportError(`import cycle: ${cycle.join(' → ')}`);
        }
        if (visited.has(entry.path)) continue;
        visited.add(entry.path);
        if (stack.length >= MAX_IMPORT_DEPTH) {
          throw new ManifestImportError(
            `${entry.path}: imports nest deeper than ${MAX_IMPORT_DEPTH} levels`,
          );
        }
        if (files.length >= MAX_IMPORT_FILES) {
          throw new ManifestImportError(
            `imports resolve to more than ${MAX_IMPORT_FILES} files — narrow the imported directories`,
          );
        }
        let raw: Record<string, unknown>;
        try {
          raw = parseManifestText(reader.read(entry.path), 'yaml');
        } catch (error) {
          if (error instanceof ImportReadPending) throw error;
          throw new ManifestImportError(
            `${entry.path}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        for (const rootOnly of ROOT_ONLY_KEYS) {
          if (raw[rootOnly] !== undefined) {
            throw new ManifestImportError(
              `${entry.path}: "${rootOnly}" is only allowed in ${root.path} — an imported file declares ${ALL_IMPORTABLE_KEYS.join(', ')} or imports`,
            );
          }
        }
        const imported: ManifestSourceFile = { path: entry.path, raw, revision: entry.revision };
        files.push(imported);
        visit(imported, [...stack, entry.path]);
      }
    }
  };

  visit(root, [root.path]);

  // Rebuild the root's key order, swapping each collection for its merged form
  // and appending collections only imported files declared.
  const merged: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(root.raw)) {
    if (key in lists) merged[key] = lists[key];
    else if (key in maps) merged[key] = maps[key];
    else merged[key] = value;
  }
  for (const key of ALL_IMPORTABLE_KEYS) {
    if (key in merged) continue;
    if (lists[key]) merged[key] = lists[key];
    else if (maps[key]) merged[key] = maps[key];
  }
  return { raw: merged, files, origins };
}

/** Thrown by the caching reader below to suspend a synchronous resolve until
 *  one more `list`/`read` result has been fetched. Never escapes this module. */
class ImportReadPending extends Error {
  constructor(
    readonly kind: 'list' | 'read',
    readonly path: string,
  ) {
    super(`pending ${kind} ${path}`);
  }
}

/**
 * `resolveManifestImportsSync` over an asynchronous store (git in the API).
 * ONE implementation of the merge rules: the synchronous resolver runs against
 * a cache, suspends on the first miss, the miss is fetched, and it runs again.
 * Each pass is an in-memory merge of at most `MAX_IMPORT_FILES` small documents.
 */
export async function resolveManifestImports(
  root: ManifestSourceFile,
  reader: ManifestImportReader,
): Promise<ResolvedManifest> {
  const lists = new Map<string, Array<{ path: string; revision?: string | null }>>();
  const texts = new Map<string, string>();
  const cached: ManifestImportReaderSync = {
    list(path) {
      const hit = lists.get(path);
      if (!hit) throw new ImportReadPending('list', path);
      return hit;
    },
    read(path) {
      const hit = texts.get(path);
      if (hit === undefined) throw new ImportReadPending('read', path);
      return hit;
    },
  };
  for (;;) {
    try {
      return resolveManifestImportsSync(root, cached);
    } catch (error) {
      if (!(error instanceof ImportReadPending)) throw error;
      if (error.kind === 'list') lists.set(error.path, await reader.list(error.path));
      else texts.set(error.path, await reader.read(error.path));
    }
  }
}

/** `collectionEntries` for the no-imports fast path: a malformed collection is
 *  the ordinary validator's finding there, not an import error. */
function safeEntries(file: string, key: ImportableKey, value: unknown) {
  try {
    return collectionEntries(file, key, value);
  } catch {
    return [];
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    return aKeys.length === bKeys.length && aKeys.every((k) => k in b && deepEqual(a[k], b[k]));
  }
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return false;
}

/**
 * Inverse of `resolveManifestImports`: distribute an edited merged document
 * back over the files it was read from.
 *
 *   - An entry stays in the file that declared it (matched by slug / map key).
 *   - A new entry goes to the root file.
 *   - A removed entry disappears from its own file; a collection left empty
 *     keeps its key (`triggers: []`).
 *   - Every non-collection key goes to the root; an imported file keeps its own
 *     `imports:` untouched.
 *
 * Returns one element per source file, root first, each flagged `changed`.
 */
export function splitManifestByOrigin(
  resolved: ResolvedManifest,
  nextRaw: Record<string, unknown>,
): SplitManifestFile[] {
  const [root, ...imported] = resolved.files;
  if (!root) return [];
  const importedPaths = new Set(imported.map((f) => f.path));
  const ownerOf = (key: ImportableKey, id: string | null): string => {
    const origin = id === null ? undefined : resolved.origins[key][id];
    return origin !== undefined && importedPaths.has(origin) ? origin : root.path;
  };

  // path → collection key → entries, in nextRaw order
  const listsByFile = new Map<string, Record<string, unknown[]>>();
  const mapsByFile = new Map<string, Record<string, Record<string, unknown>>>();
  for (const key of ALL_IMPORTABLE_KEYS) {
    for (const [id, entry] of safeEntries(root.path, key, nextRaw[key])) {
      const owner = ownerOf(key, id);
      if ((IMPORTABLE_LIST_KEYS as readonly string[]).includes(key)) {
        const bucket = listsByFile.get(owner) ?? {};
        (bucket[key] ??= []).push(entry);
        listsByFile.set(owner, bucket);
      } else if (id !== null) {
        const bucket = mapsByFile.get(owner) ?? {};
        (bucket[key] ??= {})[id] = entry;
        mapsByFile.set(owner, bucket);
      }
    }
  }
  const collectionFor = (path: string, key: ImportableKey): unknown =>
    listsByFile.get(path)?.[key] ?? mapsByFile.get(path)?.[key];

  const rebuild = (file: ManifestSourceFile, base: Record<string, unknown>) => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(base)) {
      if (!(ALL_IMPORTABLE_KEYS as readonly string[]).includes(key)) {
        out[key] = value;
        continue;
      }
      const mine = collectionFor(file.path, key as ImportableKey);
      if (mine !== undefined) out[key] = mine;
      // A file that declared this collection keeps the key when its last entry
      // is removed (`triggers: []`), rather than collapsing to `{}`: the file
      // stays readable, and a single-file import still resolves.
      else if (key in file.raw) out[key] = Array.isArray(file.raw[key]) ? [] : {};
    }
    for (const key of ALL_IMPORTABLE_KEYS) {
      if (key in out) continue;
      const mine = collectionFor(file.path, key);
      if (mine !== undefined) out[key] = mine;
    }
    return out;
  };

  return [
    toSplit(root, rebuild(root, nextRaw)),
    ...imported.map((file) => toSplit(file, rebuild(file, file.raw))),
  ];
}

function toSplit(file: ManifestSourceFile, raw: Record<string, unknown>): SplitManifestFile {
  return {
    path: file.path,
    raw,
    revision: file.revision,
    changed: !deepEqual(raw, file.raw),
  };
}
