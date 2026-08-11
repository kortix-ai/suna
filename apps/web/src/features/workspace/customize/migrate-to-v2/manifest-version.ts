'use client';

/**
 * v1-vs-v2 detection for the "Migrate to v2" surfaces. `WorkspaceConfigSummary`
 * doesn't carry a parsed `kortix_version` field, so we read it straight out
 * of the raw manifest text the workspace-detail endpoint already returns
 * (`config.manifest_raw`) — a plain regex works because both TOML
 * (`kortix_version = 1`) and YAML (`kortix_version: 2`) write it as a bare
 * `key <sep> value` line at the top of the file. Missing/unparsable defaults
 * to v1 (the schema itself treats an absent version as invalid-but-legacy —
 * treating it as "not yet migrated" is the safer UI default).
 */

import { getWorkspaceDetail } from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';
import { useQuery } from '@tanstack/react-query';

export type ManifestVersion = 1 | 2;

const VERSION_RE = /kortix_version\s*[:=]\s*"?(\d+)"?/;

export function detectManifestVersion(manifestRaw: string | null | undefined): ManifestVersion {
  if (!manifestRaw) return 1;
  const match = manifestRaw.match(VERSION_RE);
  if (!match) return 1;
  const parsed = Number(match[1]);
  return parsed >= 2 ? 2 : 1;
}

export interface WorkspaceManifestVersionState {
  /** `null` while the workspace-detail fetch is still in flight — callers that
   *  only want to show v1-only UI once resolved should treat `null` as "not
   *  yet known" rather than defaulting it to a version. */
  version: ManifestVersion | null;
  isLoading: boolean;
}

/**
 * Reads the SAME `qk.workspace.detail(id)` query the rest of Customize already
 * fetches (`customize-panel.tsx`, `config-entity-view.tsx`) — this hook
 * doesn't issue its own network request when that query is already warm;
 * react-query dedupes on the identical key + queryFn.
 */
export function useWorkspaceManifestVersion(workspaceId: string): WorkspaceManifestVersionState {
  const detail = useQuery({
    queryKey: qk.workspace.detail(workspaceId),
    queryFn: () => getWorkspaceDetail(workspaceId),
    enabled: !!workspaceId,
    ...contract('config'),
  });
  if (detail.isLoading || !detail.data) {
    return { version: null, isLoading: detail.isLoading };
  }
  return { version: detectManifestVersion(detail.data.config.manifest_raw), isLoading: false };
}
