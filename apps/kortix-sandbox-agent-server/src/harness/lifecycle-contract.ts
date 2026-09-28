/**
 * The lifecycle port, as a leaf module with no value imports.
 *
 * `harness.ts` re-exports these and adds the resolver, but it also value-imports
 * the OpenCode definition — so anything that imports `harness.ts` for a type
 * pulls the whole daemon (routes, config provider, its bun-only dependencies)
 * into its TypeScript program. `open-code/lifecycle.ts` is imported by
 * `apps/api` (managed-models drift tripwire) and must stay as light as the old
 * `opencode.ts` was: it takes the port from here.
 */

export type HarnessState = 'starting' | 'ok' | 'down'

export interface HarnessLifecycleService {
  start(): Promise<void>
  stop(signal?: NodeJS.Signals): Promise<void>
  /**
   * Stop and start the runtime. By default it then waits for readiness to
   * finalize the turn the old process took with it. `finalizeTurn: false`
   * skips that wait: for a restart before any turn exists (the boot fallback
   * chain), where a config that never becomes ready would hold it 60 s.
   */
  restart(opts?: { finalizeTurn?: boolean }): Promise<void>
  getState(): HarnessState
}
