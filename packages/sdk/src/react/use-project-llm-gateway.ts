'use client';

import { useQuery } from '@tanstack/react-query';

import { getProjectDetail, type ProjectDetail } from '../core/rest/projects-client';
import { contract } from './query-contracts';
import { qk } from './query-keys';

/**
 * Pure predicate: the project's effective `llm_gateway` flag from a
 * `getProjectDetail` response. `experimental` is the full effective flag map
 * (explicit project choice over platform default, AND-gated on operator
 * availability) — the same field `useOpenCodeProviders` forks provider
 * loading on, so every gateway-gated query in this package answers from ONE
 * source and can never disagree with the provider mode.
 */
export function projectDetailLlmGatewayEnabled(detail: ProjectDetail | undefined): boolean {
  return detail?.project?.experimental?.llm_gateway === true;
}

/**
 * The project's `llm_gateway` flag, for gating gateway-only queries
 * (`/model-defaults`, `/model-picker`, gateway routing policy — all of which
 * answer `404 llm_gateway_disabled` when the flag is off).
 *
 * `known` is false until the detail read settles: a gateway-only query must
 * hold (not fire-and-404) while the answer is loading, and a caller that
 * renders alternate native UI should wait for `known` before committing.
 *
 * Shares `qk.project.detail(id)` with every other detail reader, so this adds
 * no request on pages that already load the project shell.
 */
export function useProjectLlmGatewayEnabled(projectId: string | null | undefined): {
  enabled: boolean;
  known: boolean;
} {
  const detailQuery = useQuery({
    queryKey: qk.project.detail(projectId ?? ''),
    queryFn: () => getProjectDetail(projectId as string),
    enabled: !!projectId,
    ...contract('config'),
  });
  return {
    enabled: !!projectId && projectDetailLlmGatewayEnabled(detailQuery.data),
    known: !projectId || detailQuery.isSuccess,
  };
}
