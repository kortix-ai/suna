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
 * The error `parseManifestText` throws for text that is not YAML: a duplicate
 * key, a bad indent, an unclosed quote. Nothing in such a file can be read, so
 * the project runs in repair mode: only My Kortix, every project agent off.
 * `code` is the HTTP error code a route answers with (422).
 */
export class ManifestSyntaxError extends Error {
  readonly code = 'manifest_invalid';
  constructor(
    message: string,
    readonly line?: number,
    readonly column?: number,
  ) {
    super(message);
    this.name = 'ManifestSyntaxError';
  }
}

/**
 * The first line of a `yaml` parser message, without the source excerpt it
 * appends: "Map keys must be unique at line 54, column 3".
 */
export function yamlErrorSummary(message: string): string {
  return (message.split('\n')[0] ?? message).trim().replace(/:$/, '');
}

/** The `path` of the issue `validateManifest` reports for text that is not YAML. */
export const MANIFEST_SYNTAX_ISSUE_PATH = '<yaml>';

/** True for `ManifestSyntaxError`, also across two copies of this package. */
export function isManifestSyntaxError(err: unknown): err is ManifestSyntaxError {
  return err instanceof ManifestSyntaxError || (err as { name?: unknown } | null)?.name === 'ManifestSyntaxError';
}

/**
 * Parse manifest text into the object a reader uses: the LATEST shape, with
 * every deprecated shape rewritten (`./deprecations.ts`). Throws
 * `ManifestSyntaxError` for text that is not YAML.
 */
export function parseManifestText(raw: string): Record<string, unknown> {
  const doc = parseDocument(raw);
  const error = doc.errors[0];
  if (error) {
    const pos = error.linePos?.[0];
    throw new ManifestSyntaxError(yamlErrorSummary(error.message), pos?.line, pos?.col);
  }
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
