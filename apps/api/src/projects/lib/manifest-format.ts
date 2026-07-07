// Pure manifest-format resolution for the raw-string validate endpoint
// (`POST /projects/:id/manifest/validate`). Deliberately dependency-free
// (only `@kortix/manifest-schema`, no config/db) so it unit-tests without
// env/DB and stays importable in isolation from the heavy route graph.
import { type ManifestFormat, manifestFormatForPath } from '@kortix/manifest-schema';

/**
 * Resolve which parser to use for a raw manifest string handed to the
 * validate endpoint, in this order:
 *   1. the project's configured `manifestPath` (via `manifestFormatForPath`)
 *      — so a project explicitly created against `kortix.yaml` validates its
 *      YAML without the caller having to say so;
 *   2. an explicit `format` in the body, when the project has no
 *      `manifestPath` on record;
 *   3. `toml`, for back-compat with callers that send neither.
 *
 * Note `manifestPath` defaults to `kortix.toml` at project creation and isn't
 * updated when a repo later switches format by hand — the same staleness
 * `readManifest` (triggers.ts) works around by probing the repo directly,
 * which this raw-string endpoint (no file on disk to probe) cannot do.
 */
export function resolveManifestValidateFormat(
  manifestPath: string | null | undefined,
  bodyFormat: unknown,
): ManifestFormat {
  if (typeof manifestPath === 'string' && manifestPath.trim()) {
    return manifestFormatForPath(manifestPath);
  }
  if (bodyFormat === 'yaml' || bodyFormat === 'toml') return bodyFormat;
  return 'toml';
}
