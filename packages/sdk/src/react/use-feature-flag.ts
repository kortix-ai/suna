"use client";

import { useQuery } from "@tanstack/react-query";

import { getWorkspaceDetail } from "../core/rest/workspaces-client";
import type { FeatureFlagKey } from "../core/rest/workspaces-client";
import { contract } from "./query-contracts";
import { qk } from "./query-keys";

/** What {@link useFeatureFlag} tells a caller about one flag. */
export interface FeatureFlagState {
  /** The server said EXACTLY `true` for this workspace. Never optimistic. */
  enabled: boolean;
  /** The workspace detail has not answered yet. Treat as "not enabled". */
  isLoading: boolean;
}

/**
 * The ONE client-side gate for a per-workspace feature flag.
 *
 * Every flag-gated surface — a nav entry, a command-palette action, a page,
 * a Customize section — reads this hook, so they light up and go dark
 * together. Reads the shared `qk.workspace.detail(id)` cache entry, so it costs
 * no extra fetch alongside the detail query a workspace shell already runs.
 *
 * **Fail-closed by construction.** `enabled` is `=== true`, so a missing
 * workspace id, an in-flight query, an error, an older server that does not
 * serve the flag map, and a non-boolean wire value all resolve to `false`.
 * A disabled feature's surface must be invisible, not merely inert.
 */
export function useFeatureFlag(
  workspaceId: string | null | undefined,
  key: FeatureFlagKey,
): FeatureFlagState {
  const query = useQuery({
    queryKey: qk.workspace.detail(workspaceId ?? ""),
    queryFn: () => getWorkspaceDetail(workspaceId as string),
    enabled: !!workspaceId,
    ...contract("config"),
    refetchOnWindowFocus: false,
  });

  return {
    enabled: query.data?.workspace?.experimental?.[key] === true,
    isLoading: query.isLoading,
  };
}
