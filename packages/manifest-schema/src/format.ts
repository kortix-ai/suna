/**
 * Manifest format layer — the ONE place that knows a Kortix manifest can be
 * written as either TOML (`kortix.toml`, the original) or YAML (`kortix.yaml`).
 *
 * Resolution rule (used everywhere a manifest is read): given the project's
 * configured manifest path, prefer a sibling `.yaml` (then `.yml`), and fall
 * back to `.toml`. So a repo with BOTH files uses the YAML one, a repo with
 * only `kortix.toml` keeps working unchanged, and a repo that switched to
 * `kortix.yaml` is picked up automatically.
 *
 * The parsed OBJECT shape is identical across formats — TOML `[[agents]]` and
 * YAML `agents: [...]` both decode to `{ agents: [...] }` — so every downstream
 * parser/validator is format-agnostic; only read (which file + which parser)
 * and write (which serializer + which filename) care about the format.
 */

import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

export type ManifestFormat = 'toml' | 'yaml';

export const MANIFEST_FILENAME_TOML = 'kortix.toml';
export const MANIFEST_FILENAME_YAML = 'kortix.yaml';

/** A candidate manifest file: where it lives + how to parse/serialize it. */
export interface ManifestCandidate {
  path: string;
  format: ManifestFormat;
}

/**
 * The candidate manifest files for a project, in RESOLUTION PRIORITY order
 * (first present wins). Derived from the configured manifest path by swapping
 * the extension, so a custom path like `config/kortix.toml` still resolves its
 * `config/kortix.yaml` sibling. YAML is preferred over TOML.
 */
export function manifestCandidatePaths(configuredPath?: string | null): ManifestCandidate[] {
  const base = (configuredPath && configuredPath.trim()) || MANIFEST_FILENAME_TOML;
  const stem = base.replace(/\.(toml|ya?ml)$/i, '');
  return [
    { path: `${stem}.yaml`, format: 'yaml' },
    { path: `${stem}.yml`, format: 'yaml' },
    { path: `${stem}.toml`, format: 'toml' },
  ];
}

/** Format implied by a filename's extension. Defaults to TOML (the original). */
export function manifestFormatForPath(path: string): ManifestFormat {
  return /\.ya?ml$/i.test(path) ? 'yaml' : 'toml';
}

/** Parse manifest text into the raw object, using the given format's parser.
 *  Throws the underlying parser's syntax error (TomlError / YAMLParseError). */
export function parseManifestText(raw: string, format: ManifestFormat): Record<string, unknown> {
  const value = format === 'yaml' ? parseYaml(raw) : parseToml(raw);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    // An empty YAML doc parses to null; a scalar/array top level is invalid.
    // Normalize to an empty object so the schema validator reports the real
    // "kortix_version is required" issue instead of throwing on a null access.
    return {};
  }
  return value as Record<string, unknown>;
}

/** Serialize a manifest object back to text in the given format. */
export function serializeManifestObject(
  obj: Record<string, unknown>,
  format: ManifestFormat,
): string {
  return format === 'yaml' ? stringifyYaml(obj) : stringifyToml(obj);
}
