/**
 * Hand-off between a host's "new session" screen and the session workbench. The
 * new-session UI collects {prompt, model, agent, variant} but the session
 * runtime doesn't exist yet, so we stash them under the new session id;
 * `useSession` replays them as the first message once the runtime is ready —
 * that's how the chosen model/agent/variant apply to the opening turn. Owned by
 * the SDK so the producer (new-session screen) and consumer (`useSession`)
 * share one contract.
 *
 * ## Two producer styles
 *
 * A host with an inbox client (apps/web) writes a PICKS-ONLY stash
 * (`prompt: ''`): the prompt itself becomes a durable server row at session
 * create (or via `startSessionWithPrompt`), and only the model/agent/variant
 * hand-off still travels here. An empty prompt therefore round-trips — see
 * the picks-only test — and `useSession`'s replay sends nothing for it. A
 * host without one (apps/whitelabel-demo, the golden thin-SDK reference)
 * writes the full stash and the replay path delivers it exactly as always.
 */

export interface StartStash {
  prompt: string;
  model: { providerID: string; modelID: string } | null;
  agent: string | null;
  variant?: string | null;
  /** Epoch ms of the last write. Stamped by {@link writeStartStash}; a stash
   *  older than {@link START_STASH_TTL_MS} reads as absent. Absent on entries
   *  written before this field existed (treated as fresh once, then
   *  re-stamped by any rewrite). */
  at?: number;
}

/**
 * How long a stash stays deliverable. A stash is a hand-off for the
 * navigation that wrote it — a failed replay restores it (re-stamped), but
 * one that then sits unconsumed is a stale prompt, and replaying it into the
 * session's by-then-real conversation on a much later visit is exactly the
 * mis-delivery the warm-session work exists to prevent. 10 minutes matches
 * the API's own bound for "how stale can a delivery be and still count"
 * (UNDELIVERED_PROMPT_STARVATION_MS).
 */
export const START_STASH_TTL_MS = 10 * 60_000;

export function startStashKey(sessionId: string): string {
  return `kortix:start:${sessionId}`;
}

function sanitizeStartModel(model: StartStash['model']): StartStash['model'] {
  if (!model) return null;
  if (model.modelID === 'auto' || model.modelID === 'kortix/auto') return null;
  return model;
}

function sanitizeStartStash(stash: StartStash): StartStash {
  return { ...stash, model: sanitizeStartModel(stash.model) };
}

export function writeStartStash(sessionId: string, stash: StartStash): void {
  try {
    sessionStorage.setItem(
      startStashKey(sessionId),
      JSON.stringify({ ...sanitizeStartStash(stash), at: Date.now() }),
    );
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
      return sanitizeStartModel({ providerID: obj.providerID, modelID: obj.modelID });
    }
    return null;
  }
  if (typeof value === 'string') {
    const idx = value.indexOf('/');
    if (idx > 0 && idx < value.length - 1) {
      return sanitizeStartModel({
        providerID: value.slice(0, idx),
        modelID: value.slice(idx + 1),
      });
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
    if (raw) {
      const stash = JSON.parse(raw) as StartStash;
      // Expired: dead hand-off, not a pending prompt. Clear it so nothing —
      // including the legacy fallback below — can resurrect it.
      if (typeof stash.at === 'number' && Date.now() - stash.at > START_STASH_TTL_MS) {
        clearStartStash(sessionId);
        return null;
      }
      // The stamp is a storage detail — consumers get the hand-off payload
      // exactly as it was written.
      const { at: _at, ...payload } = stash;
      return sanitizeStartStash(payload);
    }
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
 * OpenCode session id (e.g. a project's route id, before the canonical
 * session exists); once a later render resolves the real id, this hands the
 * stash off. Reads the source via {@link readStartStash} (so it understands
 * both the canonical JSON shape and the bare-prompt legacy shape at
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
