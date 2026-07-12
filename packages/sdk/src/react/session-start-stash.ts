/**
 * Hand-off between a host's "new session" screen and the session workbench. The
 * new-session UI collects {prompt, model, agent, variant} but the session
 * runtime doesn't exist yet, so we stash them under the new session id;
 * `useSession` replays them as the first message once the runtime is ready —
 * that's how the chosen model/agent/variant apply to the opening turn. Owned by
 * the SDK so the producer (new-session screen) and consumer (`useSession`)
 * share one contract.
 */

export interface StartStash {
  prompt: string;
  model: { providerID: string; modelID: string } | null;
  agent: string | null;
  variant?: string | null;
}

export function startStashKey(sessionId: string): string {
  return `kortix:start:${sessionId}`;
}

export function writeStartStash(sessionId: string, stash: StartStash): void {
  try {
    sessionStorage.setItem(startStashKey(sessionId), JSON.stringify(stash));
  } catch {}
}

// ─────────────────────────────────────────────────────────────────────────────
// Legacy hand-off shape (pre-dates this module). Older apps/web producers
// stashed a bare prompt string plus an optional `{ agent, model, variant }`
// JSON blob under runtime-specific raw keys instead of one JSON stash.
// `readStartStash` / `clearStartStash` keep reading those keys so any in-flight
// browser hand-off survives the ACP/runtime-neutral cutover.
// ─────────────────────────────────────────────────────────────────────────────

function legacyRuntimePromptKey(sessionId: string): string {
  return `opencode_pending_prompt:${sessionId}`;
}

function legacyRuntimeOptionsKey(sessionId: string): string {
  return `opencode_pending_options:${sessionId}`;
}

function parseLegacyModel(value: unknown): StartStash['model'] {
  if (!value) return null;
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (typeof obj.providerID === 'string' && typeof obj.modelID === 'string') {
      return { providerID: obj.providerID, modelID: obj.modelID };
    }
    return null;
  }
  if (typeof value === 'string') {
    const idx = value.indexOf('/');
    if (idx > 0 && idx < value.length - 1) {
      return { providerID: value.slice(0, idx), modelID: value.slice(idx + 1) };
    }
  }
  return null;
}

function readLegacyStash(sessionId: string): StartStash | null {
  try {
    const prompt = sessionStorage.getItem(legacyRuntimePromptKey(sessionId));
    if (!prompt) return null;
    let agent: string | null = null;
    let model: StartStash['model'] = null;
    let variant: string | null = null;
    const raw = sessionStorage.getItem(legacyRuntimeOptionsKey(sessionId));
    if (raw) {
      const parsed = JSON.parse(raw) as { agent?: string; model?: unknown; variant?: string };
      if (parsed?.agent) agent = parsed.agent;
      if (parsed?.model) model = parseLegacyModel(parsed.model);
      if (parsed?.variant) variant = parsed.variant;
    }
    return { prompt, model, agent, variant };
  } catch {
    return null;
  }
}

function clearLegacyStash(sessionId: string): void {
  try {
    sessionStorage.removeItem(legacyRuntimePromptKey(sessionId));
    sessionStorage.removeItem(legacyRuntimeOptionsKey(sessionId));
  } catch {}
}

export function readStartStash(sessionId: string): StartStash | null {
  try {
    const raw = sessionStorage.getItem(startStashKey(sessionId));
    if (raw) return JSON.parse(raw) as StartStash;
  } catch {
    // fall through to the legacy shape
  }
  return readLegacyStash(sessionId);
}

export function clearStartStash(sessionId: string): void {
  try {
    sessionStorage.removeItem(startStashKey(sessionId));
  } catch {}
  clearLegacyStash(sessionId);
}

/**
 * Migrate a stash — canonical or legacy shape — from one session-id namespace
 * to another. Producers sometimes stash under an id that isn't the eventual
 * Runtime session id (e.g. a project's route id, before the canonical
 * session exists); once a later render resolves the real id, this hands the
 * stash off. Reads the source via {@link readStartStash} (so it understands
 * both the canonical JSON shape and the legacy bare-prompt shape at
 * `fromSessionId`), writes the canonical shape at `toSessionId` — skipping the
 * write if `toSessionId` already has a stash — and always clears the source
 * (both its canonical and legacy keys), whether or not there was anything to
 * migrate.
 */
export function migrateStash(fromSessionId: string, toSessionId: string): void {
  if (fromSessionId === toSessionId) return;
  try {
    if (!readStartStash(toSessionId)) {
      const stash = readStartStash(fromSessionId);
      if (stash) writeStartStash(toSessionId, stash);
    }
  } finally {
    clearStartStash(fromSessionId);
  }
}

/**
 * Migrate a differently-keyed legacy hand-off (bare prompt string + optional
 * `{agent,model,variant}` JSON options, each under their own arbitrary key)
 * onto the canonical stash for `toSessionId`. Used by producers that predate
 * this module and stash under arbitrary raw keys rather than a session-id
 * namespace `readStartStash` can resolve on its own — prefer {@link
 * migrateStash} for any producer that already writes under a session id via
 * `writeStartStash`. The source keys are always cleared, whether or not there
 * was anything to migrate.
 */
export function migrateLegacyStash(
  fromPromptKey: string,
  fromOptionsKey: string,
  toSessionId: string,
): void {
  try {
    const prompt = sessionStorage.getItem(fromPromptKey);
    if (prompt && !readStartStash(toSessionId)) {
      let agent: string | null = null;
      let model: StartStash['model'] = null;
      let variant: string | null = null;
      const raw = sessionStorage.getItem(fromOptionsKey);
      if (raw) {
        const parsed = JSON.parse(raw) as { agent?: string; model?: unknown; variant?: string };
        if (parsed?.agent) agent = parsed.agent;
        if (parsed?.model) model = parseLegacyModel(parsed.model);
        if (parsed?.variant) variant = parsed.variant;
      }
      writeStartStash(toSessionId, { prompt, model, agent, variant });
    }
  } catch {
    // ignore — worst case the hand-off is dropped, never a crash
  } finally {
    try {
      sessionStorage.removeItem(fromPromptKey);
      sessionStorage.removeItem(fromOptionsKey);
    } catch {}
  }
}
