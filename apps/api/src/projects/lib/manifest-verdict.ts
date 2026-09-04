// Server-side manifest-version verdict for GET /projects/:id/detail.
//
// The manifest declares its own schema version: `kortix_version` is REQUIRED by
// every published schema (`kortix.v1.schema.json` and
// `kortix.v2.schema.json` each pin it to a
// `const`). So the version is read, never inferred — there is no sniffing of
// which keys happen to be present.
//
// The rule this module exists to enforce: an unknown version is NEVER reported
// as v1. A manifest that is absent, unparseable, version-less, or hidden by IAM
// is `version: null` with an `unknown_reason`, and offers no migration. The old
// client-side detector defaulted all four of those cases to v1, so every
// project whose manifest could not be read was told to "upgrade".
//
// `migration_offered` is deliberately NOT `version < latest_version`. It is true
// only when MIGRATIONS below has an implemented, agent-runnable upgrade for that
// version, and `target_version` is the version that migration actually produces.
// Advertising a jump the product cannot perform is the same class of bug as
// advertising one that is not needed.

import { type ManifestFormat, parseManifestText } from '@kortix/manifest-schema';

/** Highest manifest schema version this platform ships and reads. Mirrored by
 *  `MAX_SCHEMA_VERSION` in `../triggers` (kept separate to avoid an import
 *  cycle: `triggers` pulls in the git layer, which consumes this module) and by
 *  `KNOWN_SCHEMA_VERSION` in `@kortix/manifest-schema`. All three are pinned
 *  together by `apps/api/src/__tests__/manifest-ceiling.test.ts`. */
export const LATEST_MANIFEST_VERSION = 3;

/**
 * Implemented upgrade paths, `from` → `to`. Only v1 → v2 exists (the
 * `kortix.toml` → `kortix.yaml` governance conversion).
 *
 * There is deliberately NO 2 → 3 entry. v3 is not the next rung on this
 * ladder — it is the pi runtime's manifest, and adopting it means MOVING the
 * project's agents from `.kortix/opencode` to `.kortix/pi` and running a
 * different runtime. No code performs that move, and per this module's own
 * rule, advertising a jump the product cannot perform is a bug. So a v2
 * project reads as `latest_version: 3, migration_offered: false`: honest that
 * v3 exists, honest that nothing will convert it for you.
 */
const MIGRATIONS: Readonly<Record<number, number>> = { 1: 2 };

export type ManifestUnknownReason =
  /** No manifest text — absent from the repo, or the repo read failed. */
  | 'unreadable'
  /** Manifest text exists but its own parser rejected it. */
  | 'unparsable'
  /** Parses, but declares no usable integer `kortix_version`. */
  | 'undeclared'
  /** Hidden from this caller — no `project.customize.read`. */
  | 'restricted';

export interface ProjectManifestVerdict {
  /** Declared `kortix_version`. `null` whenever `unknown_reason` is set. */
  version: number | null;
  /** Highest version this platform understands. */
  latest_version: number;
  /** True only for a known version with an implemented upgrade path. */
  migration_offered: boolean;
  /** Version the offered migration produces. `null` when none is offered. */
  target_version: number | null;
  /** Why `version` is null. `null` when the version is known. */
  unknown_reason: ManifestUnknownReason | null;
  /** Repo path the manifest was read from, when one was read. */
  path: string | null;
}

function unknown(reason: ManifestUnknownReason, path: string | null): ProjectManifestVerdict {
  return {
    version: null,
    latest_version: LATEST_MANIFEST_VERSION,
    migration_offered: false,
    target_version: null,
    unknown_reason: reason,
    path,
  };
}

/** The verdict for a caller who may not read the project's config. */
export function restrictedManifestVerdict(): ProjectManifestVerdict {
  return unknown('restricted', null);
}

function declaredVersion(parsed: Record<string, unknown>): number | null {
  const raw = parsed.kortix_version;
  const n =
    typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.trim()) : Number.NaN;
  if (!Number.isFinite(n)) return null;
  const floored = Math.floor(n);
  return floored >= 1 ? floored : null;
}

export function resolveManifestVerdict(input: {
  raw: string | null | undefined;
  format: ManifestFormat;
  path: string | null;
}): ProjectManifestVerdict {
  const { raw, format, path } = input;
  if (!raw || !raw.trim()) return unknown('unreadable', path);

  let parsed: Record<string, unknown>;
  try {
    parsed = parseManifestText(raw, format);
  } catch {
    return unknown('unparsable', path);
  }

  const version = declaredVersion(parsed);
  if (version === null) return unknown('undeclared', path);

  const target = MIGRATIONS[version] ?? null;
  return {
    version,
    latest_version: LATEST_MANIFEST_VERSION,
    migration_offered: target !== null,
    target_version: target,
    unknown_reason: null,
    path,
  };
}
