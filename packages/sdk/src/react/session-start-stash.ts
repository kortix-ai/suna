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
// Legacy hand-off shape (pre-dates this module). apps/web had several
// independent "new session" producers (dashboard, project workspace, legacy
// composer) that stash a bare prompt string under `opencode_pending_prompt:<id>`
// plus an optional `{ agent, model, variant }` JSON blob under
// `opencode_pending_options:<id>` — instead of one JSON stash. Those call sites
// are unchanged (out of scope for this migration); `readStartStash` /
// `clearStartStash` understand both shapes so every existing producer keeps
// working through the one shared contract.
// ─────────────────────────────────────────────────────────────────────────────

function legacyPromptKey(sessionId: string): string {
  return `opencode_pending_prompt:${sessionId}`;
}

function legacyOptionsKey(sessionId: string): string {
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
    const prompt = sessionStorage.getItem(legacyPromptKey(sessionId));
    if (!prompt) return null;
    let agent: string | null = null;
    let model: StartStash['model'] = null;
    let variant: string | null = null;
    const raw = sessionStorage.getItem(legacyOptionsKey(sessionId));
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
    sessionStorage.removeItem(legacyPromptKey(sessionId));
    sessionStorage.removeItem(legacyOptionsKey(sessionId));
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
 * Migrate a differently-keyed legacy hand-off (bare prompt string + optional
 * `{agent,model,variant}` JSON options, each under their own arbitrary key)
 * onto the canonical stash for `toSessionId`. Used when a producer stashes
 * under one id namespace (e.g. a project's route id, before the canonical
 * OpenCode session exists) and a later render resolves the real session id —
 * the source keys are always cleared, whether or not there was anything to
 * migrate.
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
