/**
 * The manifest file: `kortix.yaml` (or `kortix.yml`), read and written as YAML.
 */

import { parseDocument, stringify as stringifyYaml } from 'yaml';
import { applyDeprecations } from './deprecations';

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

/**
 * Parse manifest text into the object a reader uses: the LATEST shape, with
 * every deprecated shape rewritten (`./deprecations.ts`). Throws the YAML
 * syntax error.
 */
export function parseManifestText(raw: string): Record<string, unknown> {
  const doc = parseDocument(raw);
  if (doc.errors.length > 0) throw doc.errors[0];
  applyDeprecations(doc);
  const value = doc.toJS() as unknown;
  // An empty document parses to null; a scalar or list top level is not a manifest.
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

/** Serialize a manifest object to YAML. */
export function serializeManifestObject(obj: Record<string, unknown>): string {
  return stringifyYaml(obj);
}
