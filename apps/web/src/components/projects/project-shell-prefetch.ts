'use client';

/**
 * Start the project shell's own reads BEFORE `ProjectShell` mounts — the same
 * "prefetch beside the access check" pattern `session-route-prefetch.ts` uses
 * for a session route.
 *
 * THE PROBLEM. `ProjectAccessBoundary` renders NOTHING but a full-page loading
 * frame until its own `getProject` resolves (+2.1s on a cold dev load) —
 * `ProjectShell` (the sidebar, the composer, the whole `/projects/<id>` tree)
 * is one of its `children`, so nothing under it can even START a query before
 * that. Once `getProject` resolves, `ProjectShell`'s own chunk still has to
 * load and hydrate before its hooks run — another few hundred ms — and only
 * THEN does the burst of "shell" reads fire: project detail, the sessions
 * list, sandbox health, the model picker.
 *
 * None of those four needs anything `getProject` returns. They need only
 * `projectId`, exactly like `getProject` itself — the API authorizes each of
 * them independently, so starting them in parallel with the access check is
 * safe: a 403/404 on `getProject` still renders the boundary's denial screen,
 * and a request this user cannot make simply answers 403/404 too (`prefetchQuery`
 * swallows the error; nothing renders from it until a real hook mounts and
 * decides what a failure means for its own screen).
 *
 * THE FIX. Fire the same reads from here, at the SAME point `getProject`
 * fires, using the EXACT query keys and options their real consuming hooks
 * use, so the later hook mount finds warm or in-flight data instead of firing
 * a second request:
 *
 *   - project detail   → `qk.project.detail(id)`      (`ProjectShell`, `useProjectCanRun`, …)
 *   - sessions list     → `qk.project.sessionsPaged(id, 'visible')` (the sidebar's `useProjectSessions`)
 *   - sandbox health    → `SANDBOX_HEALTH_QUERY_KEY(id)` (`useSandboxHealth`, the sidebar footer)
 *   - model picker      → `qk.project.modelPicker(id)`  (`useProjectModels` / `useProjectModelPickerCatalog`)
 *
 * MODEL PICKER IS A REAL SECOND HOP, NOT A PARALLEL READ. It only exists for a
 * project with `llm_gateway` enabled — a flag that lives INSIDE the detail
 * response (the same rule `use-project-llm-gateway.ts`'s
 * `projectDetailLlmGatewayEnabled` applies; that predicate is package-internal,
 * not re-exported from `@kortix/sdk/react`, so `gatewayEnabledFromDetail` below
 * duplicates its one-line check rather than taking on a new SDK public-surface
 * export for a single boolean read). Firing it unconditionally would 404
 * `llm_gateway_disabled` for every native project. So it waits on detail
 * resolving here too, but that wait is ONE hop against an already-in-flight
 * read, not a wait for the whole shell to mount — still strictly earlier than
 * today's serialized wave.
 *
 * WHAT THIS DELIBERATELY DOES NOT FLATTEN. Billing (`account-state`) and the
 * IAM `effective`/`effective:batch` probes need `project.account_id`, which
 * ONLY exists once `detail` resolves — a real dependency, not an artificial
 * one, and prefetching `detail` here already gives them the earliest possible
 * start (the instant `detail` resolves, not the instant `ProjectShell`'s own
 * chunk mounts afterward — see `use-project-can-run.ts`, which shares this
 * exact `qk.project.detail(id)` entry). `POST .../sessions/warm`
 * (`use-warm-project-session.ts`) is gated on the SAME billing verdict for a
 * real reason (never spend a box on an account that cannot run) and is a
 * WRITE, so it is not prefetched here at all — only the read that unblocks it
 * sooner.
 */

import type { QueryClient } from '@tanstack/react-query';

import {
  getProjectDetail,
  getProjectModelPicker,
  getProjectSandboxHealth,
  listProjectSessionsPage,
  type ProjectDetail,
} from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';

import { SANDBOX_HEALTH_QUERY_KEY } from '@/features/workspace/project-sidebar/footer/project-sandbox-alert';

/**
 * Same rule as `projectDetailLlmGatewayEnabled` (`packages/sdk/src/react/use-
 * project-llm-gateway.ts`), duplicated rather than imported — see the doc
 * comment above for why. Pure, so it is independently testable.
 */
export function gatewayEnabledFromDetail(detail: ProjectDetail | undefined): boolean {
  return detail?.project?.experimental?.llm_gateway === true;
}

/**
 * The real second hop: the model picker only exists for a gateway-enabled
 * project, and that flag lives inside the detail response. `fetchQuery`
 * (not `prefetchQuery`) so this function gets the resolved value back —
 * it still populates the exact same `qk.project.detail(id)` cache entry every
 * other detail reader shares, with the same options, so this is not a second,
 * differently-configured read of the same data.
 */
async function prefetchModelPickerOnceGatewayKnown(
  queryClient: QueryClient,
  projectId: string,
): Promise<void> {
  const detail = await queryClient
    .fetchQuery({
      queryKey: qk.project.detail(projectId),
      queryFn: () => getProjectDetail(projectId),
      ...contract('config'),
    })
    .catch(() => undefined);
  if (!gatewayEnabledFromDetail(detail)) return;
  await queryClient
    .prefetchQuery({
      queryKey: qk.project.modelPicker(projectId),
      queryFn: () => getProjectModelPicker(projectId),
      ...contract('config'),
    })
    .catch(() => undefined);
}

/**
 * Fire the project shell's detail/sessions/sandbox-health reads for
 * `projectId` as soon as the route names it, plus the model picker once
 * detail says the project's gateway is on. Fire-and-forget, never throws.
 */
export function prefetchProjectShellReads(queryClient: QueryClient, projectId: string): void {
  if (!projectId) return;

  void prefetchModelPickerOnceGatewayKnown(queryClient, projectId);

  void queryClient.prefetchInfiniteQuery({
    queryKey: qk.project.sessionsPaged(projectId, 'visible'),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      listProjectSessionsPage(projectId, { scope: 'visible', cursor: pageParam }),
    ...contract('inventory'),
  });

  void queryClient.prefetchQuery({
    queryKey: SANDBOX_HEALTH_QUERY_KEY(projectId),
    queryFn: () => getProjectSandboxHealth(projectId),
    staleTime: 30_000,
  });
}
