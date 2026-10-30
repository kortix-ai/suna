/**
 * The manifest file: `kortix.yaml` (or `kortix.yml`), read and written as YAML.
 */

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

export const MANIFEST_FILENAME = 'kortix.yaml';

/**
 * The manifest files a project may have, in resolution order (first present
 * wins). A configured path keeps its directory; its extension is replaced, so
 * a project row that still says `kortix.toml` finds its `kortix.yaml`.
 */
export function manifestCandidatePaths(configuredPath?: string | null): string[] {
  const stem = (configuredPath?.trim() || MANIFEST_FILENAME).replace(/\.(toml|ya?ml)$/i, '');
  return [`${stem}.yaml`, `${stem}.yml`];
}

/** Parse manifest text into the raw object. Throws the YAML syntax error. */
export function parseManifestText(raw: string): Record<string, unknown> {
  const value = parseYaml(raw);
  // An empty document parses to null; a scalar or list top level is not a manifest.
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

/** Serialize a manifest object to YAML. */
export function serializeManifestObject(obj: Record<string, unknown>): string {
  return stringifyYaml(obj);
}

/** `text` without its top-level `kortix_version` line (obsolete: a Kortix write never keeps it). Every other byte stays. */
export function dropVersionLine(text: string): string {
  return text.replace(/^kortix_version[ \t]*:.*(?:\r?\n|$)/m, '');
}
