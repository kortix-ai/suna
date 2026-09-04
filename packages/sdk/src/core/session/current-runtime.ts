/**
 * The current session runtime addresses. `url` is the control runtime that owns
 * the model loop and event stream. `workspaceUrl` is the runtime that owns
 * files, PTYs, and ports. They are equal for one-box sessions and distinct for
 * Pi sessions.
 *
 * This replaces the old global "active server" machinery. A session binds here
 * `useSession` sets the control address on open and clears both addresses on
 * unmount. Workspace surfaces resolve the data address lazily. There is no
 * servers[] registry and no server-switch cascade.
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
  /** The owner of repository files, PTYs, and user-exposed ports. */
  dataRuntimeKind: 'worker' | 'environment' | null;
  /** Data-runtime URL. Null while a Pi environment is not attached. */
  workspaceUrl: string | null;
  /** Provider id for the data runtime. */
  workspaceSandboxId: string | null;
  /**
   * True once this session's open-bundle has been applied (its runtime-state
   * roster — agents/commands/sessions — seeded into the query caches, or the
   * bundle resolved without one). The roster hooks gate their OWN proxied
   * `/agent` `/command` `/session` reads on this so they read the seeded cache
   * instead of racing the bundle and each firing a redundant read. Resets to
   * false on every runtime switch (a new session's bundle has not landed yet).
   */
  bundleApplied: boolean;
  version: number;
  /** Changes only when the workspace address changes. */
  workspaceVersion: number;
}

let state: CurrentRuntimeState = {
  url: null,
  sandboxId: null,
  dbSandboxId: null,
  dataRuntimeKind: null,
  workspaceUrl: null,
  workspaceSandboxId: null,
  bundleApplied: false,
  version: 0,
  workspaceVersion: 0,
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
  dataRuntimeKind: 'worker' | 'environment' | null = url ? 'worker' : null,
): void {
  const workspaceUrl = dataRuntimeKind === 'worker' ? url : null;
  const workspaceSandboxId = dataRuntimeKind === 'worker' ? sandboxId : null;
  if (
    state.url === url &&
    state.sandboxId === sandboxId &&
    state.dbSandboxId === dbSandboxId &&
    state.dataRuntimeKind === dataRuntimeKind &&
    state.workspaceUrl === workspaceUrl &&
    state.workspaceSandboxId === workspaceSandboxId
  )
    return;
  // A new runtime: its bundle has not been applied yet, so the roster hooks
  // wait for it again rather than reading the previous session's seeded cache.
  state = {
    url,
    sandboxId,
    dbSandboxId,
    dataRuntimeKind,
    workspaceUrl,
    workspaceSandboxId,
    bundleApplied: false,
    version: state.version + 1,
    workspaceVersion: state.workspaceVersion + 1,
  };
  for (const listener of listeners) listener();
}

/** Bind the repository/file/PTY/port runtime without changing the Pi control runtime. */
export function setCurrentWorkspaceRuntime(
  url: string | null,
  sandboxId: string | null = null,
): void {
  if (state.workspaceUrl === url && state.workspaceSandboxId === sandboxId) return;
  state = {
    ...state,
    workspaceUrl: url,
    workspaceSandboxId: sandboxId,
    workspaceVersion: state.workspaceVersion + 1,
  };
  for (const listener of listeners) listener();
}

/**
 * Mark the current runtime's open-bundle as applied — called once the
 * runtime-state leg has been seeded (or the bundle resolved without one). This
 * releases the roster hooks to read the seeded caches. Idempotent.
 */
export function markCurrentRuntimeBundleApplied(): void {
  if (state.bundleApplied) return;
  state = { ...state, bundleApplied: true, version: state.version + 1 };
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

/** Read the workspace runtime URL outside React. */
export function getCurrentWorkspaceRuntimeUrl(): string | null {
  return state.workspaceUrl;
}

/** Read the workspace runtime provider id outside React. */
export function getCurrentWorkspaceRuntimeSandboxId(): string | null {
  return state.workspaceSandboxId;
}
