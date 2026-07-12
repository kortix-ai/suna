/**
 * The current session runtime — the ONE Runtime daemon the app is talking to
 * right now (the sandbox of the session being viewed), as a proxy URL
 * `${backendUrl}/p/<external_id>/8000`.
 *
 * This replaces the old global "active server" machinery. A session binds here
 * (`useSession` sets it on open, clears it on unmount); every runtime read —
 * `getClient()`, the SSE stream, the file/terminal/git hooks — resolves through
 * it; switching sessions just sets a new url. There is no servers[] registry, no
 * `serverVersion`, no reset-cascade. `version` bumps on every change so the SSE
 * stream re-subscribes to the new daemon.
 *
 * This module is part of the isomorphic core (reachable from the root
 * `@kortix/sdk` export), so it is a plain hand-rolled store — no zustand, no
 * React. The React selector hook lives at `react/use-current-runtime`.
 */
export interface CurrentRuntimeState {
  url: string | null;
  /** The sandbox's external_id (Daytona id) — used for proxy routing. */
  sandboxId: string | null;
  /** The sandbox's DB instance id (platform `sandbox_id`) — used by ownership-
   *  scoped APIs like per-sandbox API keys that key on the DB row, not the
   *  external id (which the backend would mistake for the primary key). */
  dbSandboxId: string | null;
  version: number;
}

let state: CurrentRuntimeState = {
  url: null,
  sandboxId: null,
  dbSandboxId: null,
  version: 0,
};

const listeners = new Set<() => void>();

/** Framework-free store over the current runtime (getState/subscribe). */
export const currentRuntimeStore = {
  getState(): CurrentRuntimeState {
    return state;
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

/**
 * Point the app at a session's runtime. `null` clears it (no active session) — the
 * next runtime read then has no url and callers wait, exactly as before a session
 * is open.
 */
export function setCurrentRuntime(
  url: string | null,
  sandboxId: string | null = null,
  dbSandboxId: string | null = null,
): void {
  if (state.url === url && state.sandboxId === sandboxId && state.dbSandboxId === dbSandboxId)
    return;
  state = { url, sandboxId, dbSandboxId, version: state.version + 1 };
  for (const listener of listeners) listener();
}

/** Read the current runtime url outside React (API modules, the client factory). */
export function getCurrentRuntimeUrl(): string | null {
  return state.url;
}

/** Read the current runtime sandbox id (external_id) outside React. */
export function getCurrentRuntimeSandboxId(): string | null {
  return state.sandboxId;
}

/** Read the current runtime DB sandbox id (platform `sandbox_id`) outside React. */
export function getCurrentRuntimeDbSandboxId(): string | null {
  return state.dbSandboxId;
}
