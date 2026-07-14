/**
 * Hand-off between a host's "new session" screen and the session workbench.
 * The new-session UI collects the draft prompt before the session runtime
 * exists, so it's stashed under the new session id; `useSession` replays it
 * as the first message once the runtime is ready. Owned by the SDK so the
 * producer (new-session screen) and consumer (`useSession`) share one
 * contract.
 *
 * `model`/`agent`/`variant` used to ride along here too, but nothing ever
 * reads them back — the execution route (agent, harness, connection, model
 * policy) is resolved once at session CREATE time and is immutable
 * thereafter (docs/specs/2026-07-14-provider-auth-model-management.md §3.6,
 * §8), and ACP `session/prompt` never carries a model/provider override
 * (§7.3). Only `prompt` is real; writers that still pass the old fields are
 * harmless (this module simply ignores them).
 */

export interface StartStash {
  prompt: string;
}

export function startStashKey(sessionId: string): string {
  return `kortix:start:${sessionId}`;
}

/**
 * `stash` accepts (and ignores) arbitrary extra properties alongside
 * `prompt` — generic rather than a plain `StartStash` parameter so both a
 * bare `{ prompt }` object AND one with legacy extra fields typecheck. A few
 * producers outside this package's ownership still pass the retired
 * `agent`/`model`/`variant` fields — harmless at runtime (nothing reads them
 * back, see the module doc above) and intentionally not a type error here,
 * so those call sites don't need a synchronized edit.
 */
export function writeStartStash<T extends StartStash>(sessionId: string, stash: T): void {
  try {
    sessionStorage.setItem(startStashKey(sessionId), JSON.stringify(stash));
  } catch {}
}

// ─────────────────────────────────────────────────────────────────────────────
// Legacy hand-off shape (pre-dates this module). Older apps/web producers
// stashed a bare prompt string under a runtime-specific raw key instead of one
// JSON stash (and, further back, alongside a `{ agent, model, variant }`
// options blob — now ignored, see the module doc above). `readStartStash` /
// `clearStartStash` keep reading those keys so any in-flight browser hand-off
// survives the ACP/runtime-neutral cutover.
// ─────────────────────────────────────────────────────────────────────────────

function legacyRuntimePromptKey(sessionId: string): string {
  return `opencode_pending_prompt:${sessionId}`;
}

function legacyRuntimeOptionsKey(sessionId: string): string {
  return `opencode_pending_options:${sessionId}`;
}

function readLegacyStash(sessionId: string): StartStash | null {
  try {
    const prompt = sessionStorage.getItem(legacyRuntimePromptKey(sessionId));
    if (!prompt) return null;
    return { prompt };
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
 * Migrate a differently-keyed legacy hand-off (bare prompt string, formerly
 * paired with an `{agent,model,variant}` JSON options blob under its own
 * arbitrary key — now ignored, see the module doc above) onto the canonical
 * stash for `toSessionId`. Used by producers that predate this module and
 * stash under arbitrary raw keys rather than a session-id namespace
 * `readStartStash` can resolve on its own — prefer {@link migrateStash} for
 * any producer that already writes under a session id via `writeStartStash`.
 * `fromOptionsKey` is only cleared, never read. The source keys are always
 * cleared, whether or not there was anything to migrate.
 */
export function migrateLegacyStash(
  fromPromptKey: string,
  fromOptionsKey: string,
  toSessionId: string,
): void {
  try {
    const prompt = sessionStorage.getItem(fromPromptKey);
    if (prompt && !readStartStash(toSessionId)) {
      writeStartStash(toSessionId, { prompt });
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
