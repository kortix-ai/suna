import { type KortixPlatformConfig, platformConfig } from '../http/config';
import { loadPreviewUrlTemplate } from '../session/preview-config';
import {
  type SessionRuntimeEntry,
  clearSessionRuntime,
  getSessionRuntime,
} from '../session/session-runtime-registry';
import { SessionNotReadyError, inFlightSessionStarts } from './session-shared';
import { bindSessionStart } from './session-start';
export function bindSessionReadiness(
  projectId: string,
  sessionId: string,
  config: KortixPlatformConfig,
) {
  let _ready: SessionRuntimeEntry | null = null;
  function tryResolveReady(): SessionRuntimeEntry | null {
    if (_ready) return _ready;
    const cached = getSessionRuntime(projectId, sessionId);
    if (cached) _ready = cached;
    return _ready;
  }

  /**
   * Make this session's runtime reachable and return its OpenCode session id
   * (plus this handle's own resolved runtime URL + sandbox id). Idempotent:
   * adopts the registry entry if another handle already resolved this
   * session; otherwise `start` provisions/resumes the sandbox (long-poll
   * until ready) — which itself populates the registry on success — and we
   * cache the resolved runtime for THIS handle. Also points the app's shared
   * "current runtime" store there, for React hosts that still read it.
   */
  const startRuntime = bindSessionStart(projectId, sessionId);

  async function ensureReady(opts?: { readyTimeoutMs?: number }): Promise<SessionRuntimeEntry> {
    const cached = tryResolveReady();
    if (cached) return cached;
    const readyTimeoutMs = opts?.readyTimeoutMs ?? 180_000;

    // Learn how this deployment addresses previews while the sandbox boots.
    // `previewUrl()` is synchronous (a React render calls it), so the answer
    // has to be here before it can be asked for. Runs alongside the start
    // poll and never gates it — a failure just leaves the path form.
    const previewConfig = loadPreviewUrlTemplate(
      platformConfig().backendUrl ?? config.backendUrl,
    ).catch(() => null);

    // Dedup concurrent starts for this (projectId, sessionId) — see
    // `inFlightSessionStarts`'s doc comment. If another call (this handle or
    // a different one) already kicked off `/start`, ride its result instead
    // of issuing a second POST.
    const key = `${projectId}\n${sessionId}`;
    const inFlight = inFlightSessionStarts.get(key);
    if (inFlight) {
      _ready = await inFlight;
      await previewConfig;
      return _ready;
    }

    const startPromise = startRuntime(readyTimeoutMs);

    inFlightSessionStarts.set(key, startPromise);
    try {
      _ready = await startPromise;
      // Resolved concurrently with the boot above, so this is already
      // settled — awaited here only so `previewUrl()` can never be reached
      // before the deployment's preview addressing is known.
      await previewConfig;
      return _ready;
    } finally {
      if (inFlightSessionStarts.get(key) === startPromise) {
        inFlightSessionStarts.delete(key);
      }
    }
  }

  /** Throw `SessionNotReadyError` if neither this handle nor the registry has resolved a runtime yet. */
  function requireReady(action: string): SessionRuntimeEntry {
    const ready = tryResolveReady();
    if (!ready) throw new SessionNotReadyError(action);
    return ready;
  }

  /** Clear this handle's cached runtime + the shared registry entry (restart/delete). */
  function forgetReady(): void {
    _ready = null;
    clearSessionRuntime(projectId, sessionId);
  }

  return { ensureReady, tryResolveReady, requireReady, forgetReady };
}
