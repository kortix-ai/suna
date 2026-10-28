'use client';

/**
 * Manifest version detection for the manifest upgrade surfaces. `ProjectConfigSummary`
 * doesn't carry a parsed `kortix_version` field, so we read it straight out
 * of the raw manifest text the project-detail endpoint already returns
 * (`config.manifest_raw`) — a plain regex works because both TOML
 * (`kortix_version = 1`) and YAML (`kortix_version: 3`) write it as a bare
 * `key <sep> value` line at the top of the file. Missing/unparsable defaults
 * to v1 (the schema itself treats an absent version as invalid-but-legacy —
 * treating it as "not yet migrated" is the safer UI default).
 */

import { getProjectDetail, repositoryDisconnectedReason } from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';
import { useQuery } from '@tanstack/react-query';

export type ManifestVersion = 1 | 2 | 3;

const VERSION_RE = /kortix_version\s*[:=]\s*"?(\d+)"?/;

export function detectManifestVersion(manifestRaw: string | null | undefined): ManifestVersion {
  if (!manifestRaw) return 1;
  const match = manifestRaw.match(VERSION_RE);
  if (!match) return 1;
  const parsed = Number(match[1]);
  // A version newer than this client reads as the newest it knows.
  return parsed >= 3 ? 3 : parsed === 2 ? 2 : 1;
}

/** The manifest file a version lives in. An unresolved read (`null`) reads as v1. */
export function manifestFilename(version: number | null): 'kortix.toml' | 'kortix.yaml' {
  return (version ?? 1) >= 2 ? 'kortix.yaml' : 'kortix.toml';
}

/** A v1 or v2 project is offered the upgrade to v3. `null` (not read yet) is not. */
export function manifestNeedsUpgrade(version: ManifestVersion | null): boolean {
  return version === 1 || version === 2;
}

export interface ProjectManifestVersionState {
  /** `null` while the project-detail fetch is still in flight — callers that
   *  only want to show v1-only UI once resolved should treat `null` as "not
   *  yet known" rather than defaulting it to a version. */
  version: ManifestVersion | null;
  isLoading: boolean;
}

/**
 * Reads the SAME `qk.project.detail(id)` query the rest of Customize already
 * fetches — this hook
 * doesn't issue its own network request when that query is already warm;
 * react-query dedupes on the identical key + queryFn.
 */
export function useProjectManifestVersion(projectId: string): ProjectManifestVersionState {
  const detail = useQuery({
    queryKey: qk.project.detail(projectId),
    queryFn: () => getProjectDetail(projectId),
    enabled: !!projectId,
    ...contract('config'),
  });
  if (detail.isLoading || !detail.data) {
    return { version: null, isLoading: detail.isLoading };
  }
  // A disconnected repository was not read: its version is unknown, not v1,
  // so no surface offers an upgrade it cannot run (KRTX-2955).
  if (repositoryDisconnectedReason(detail.data.git_connection)) return { version: null, isLoading: false };
  return { version: detectManifestVersion(detail.data.config.manifest_raw), isLoading: false };
}
