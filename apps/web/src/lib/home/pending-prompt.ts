/**
 * Carries a prompt typed on the logged-out homepage across sign-in.
 *
 * Deliberately NOT the session start-stash. That stash is keyed by a session id
 * that does not exist yet, and its consumer auto-sends on arrival — wrong for a
 * first billable action taken by someone who has not yet seen a real composer.
 * This only prefills; the user still presses send.
 */

const KEY = 'kortix.pendingPrompt';
const TTL_MS = 30 * 60 * 1000;
const MAX_LENGTH = 8_000;

interface PendingPrompt {
  text: string;
  at: number;
}

export function writePendingPrompt(text: string, now: number = Date.now()): void {
  if (typeof sessionStorage === 'undefined') return;
  const trimmed = text.trim();
  if (!trimmed) return;
  try {
    const payload: PendingPrompt = { text: trimmed.slice(0, MAX_LENGTH), at: now };
    sessionStorage.setItem(KEY, JSON.stringify(payload));
  } catch {
    // Private mode / quota — losing the prefill is not worth breaking sign-in.
  }
}

/** Read and remove. Returns null when absent, malformed, or stale. */
export function consumePendingPrompt(now: number = Date.now()): string | null {
  if (typeof sessionStorage === 'undefined') return null;
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    sessionStorage.removeItem(KEY);
    const parsed = JSON.parse(raw) as Partial<PendingPrompt>;
    if (typeof parsed?.text !== 'string' || typeof parsed?.at !== 'number') return null;
    // An hours-old prompt is a surprise, not a convenience.
    if (now - parsed.at > TTL_MS) return null;
    return parsed.text || null;
  } catch {
    return null;
  }
}

export function clearPendingPrompt(): void {
  if (typeof sessionStorage === 'undefined') return;
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* no-op */
  }
}

export const PENDING_PROMPT_TTL_MS = TTL_MS;
export const PENDING_PROMPT_KEY = KEY;
