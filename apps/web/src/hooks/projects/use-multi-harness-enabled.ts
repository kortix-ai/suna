'use client';

import { getProjectDetail } from '@kortix/sdk';
import { useQuery } from '@tanstack/react-query';

/**
 * The single on/off switch for ACP / multi-harness chrome, read from the
 * server's per-project experimental flags (`acp_runtime`) — the SAME flag the
 * API's `resolveProjectRuntimeTransport` reads to pick ACP over the OpenCode
 * REST compatibility transport.
 *
 * Why the transport flag gates harness UI: `claude`, `codex`, and `pi` are ACP
 * adapters. Their credentials and identity only ever reach a sandbox through an
 * ACP session (see apps/kortix-sandbox-agent-server/src/acp/harness-registry.ts,
 * which is the only reader of `CLAUDE_CODE_OAUTH_TOKEN`). With `acp_runtime`
 * off, every session runs `opencode` over REST, so a harness picker, a harness
 * favicon, and a harness-scoped subscription form all describe something the
 * deployment cannot launch. `apps/api/src/projects/lib/harness-gate.ts` is the
 * second, server-side gate: even with ACP on, an experimental harness starts
 * only where an operator named it in `KORTIX_ENABLED_HARNESSES`.
 *
 * Reads the shared `['project-detail', projectId]` cache entry, so it adds no
 * extra fetch alongside the detail query the surrounding surfaces already run.
 */
export function useMultiHarnessEnabled(projectId: string | undefined): boolean {
  const { data } = useQuery({
    queryKey: ['project-detail', projectId],
    queryFn: () => getProjectDetail(projectId as string),
    enabled: !!projectId,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  return data?.project?.experimental?.acp_runtime ?? false;
}
