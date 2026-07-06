/**
 * Hand-off between a host's "new session" screen and the session workbench. The
 * new-session UI collects {prompt, model, agent, variant} but the session
 * runtime doesn't exist yet, so we stash them under the new session id;
 * `useSession` replays them as the first message once the runtime is ready —
 * that's how the chosen model/agent/variant apply to the opening turn. Owned by
 * the SDK so the producer (new-session screen) and consumer (`useSession`)
 * share one contract.
 */
import type { PromptPart } from './use-opencode-sessions/keys';

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

// ─────────────────────────────────────────────────────────────────────────────
// Fork-draft stash. A sibling hand-off to the start-stash above, but for the
// "fork this message" flow: apps/web's session-chat stashes the forked
// message's parts (text + file refs) under the NEW forked session's id so its
// composer can pick them up as a pre-filled draft once it mounts. Previously
// apps/web/session-chat.tsx and session-chat-input.tsx each independently
// redefined the same `opencode_fork_prompt:<id>` key — unified here so both
// (and any future host) share one contract. The storage key is unchanged for
// back-compat with anything already stashed under it.
// ─────────────────────────────────────────────────────────────────────────────

export function forkDraftKey(sessionId: string): string {
  return `opencode_fork_prompt:${sessionId}`;
}

/** Stash a fork's prompt parts for the forked session to pick up as a draft.
 * No-ops when there's nothing to stash. */
export function writeForkDraft(sessionId: string, prompt: PromptPart[]): void {
  if (prompt.length === 0) return;
  try {
    sessionStorage.setItem(forkDraftKey(sessionId), JSON.stringify(prompt));
  } catch {}
}

/** Read back a stashed fork draft, if any. Does not clear it — call
 * `clearForkDraft` once consumed. */
export function readForkDraft(sessionId: string): PromptPart[] | null {
  try {
    const raw = sessionStorage.getItem(forkDraftKey(sessionId));
    if (!raw) return null;
    return JSON.parse(raw) as PromptPart[];
  } catch {
    return null;
  }
}

export function clearForkDraft(sessionId: string): void {
  try {
    sessionStorage.removeItem(forkDraftKey(sessionId));
  } catch {}
}
