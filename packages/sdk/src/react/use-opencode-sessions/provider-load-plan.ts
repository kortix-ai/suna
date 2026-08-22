/**
 * Which provider-list source `useOpenCodeProviders` reads. Gateway mode is the
 * only mode: a project route always reads the gateway's `/model-picker`
 * (runtime-free, so the picker paints before the sandbox boots); outside a
 * project route there is no model-picker to ask, so the runtime's own
 * `provider.list` is the source, once the runtime is reachable.
 */
export function providerQueryPlan(input: {
  projectId: string | null;
  runtimeReady: boolean;
}): { gateway: boolean; runtime: boolean } {
  if (input.projectId) return { gateway: true, runtime: false };
  return { gateway: false, runtime: input.runtimeReady };
}
