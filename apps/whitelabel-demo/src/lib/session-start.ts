/**
 * Hand-off between the "new session" screen and the session workbench. The home
 * collects {prompt, model, agent} but the session runtime doesn't exist yet, so
 * we stash them under the new session id and the workbench replays them as the
 * first message once the runtime is ready — that's how the chosen model/agent
 * actually apply to the opening turn.
 */
export interface StartStash {
  prompt: string;
  model: { providerID: string; modelID: string } | null;
  agent: string | null;
}

export function startStashKey(sessionId: string): string {
  return `kortix:start:${sessionId}`;
}

export function readStartStash(sessionId: string): StartStash | null {
  try {
    const raw = sessionStorage.getItem(startStashKey(sessionId));
    return raw ? (JSON.parse(raw) as StartStash) : null;
  } catch {
    return null;
  }
}

export function clearStartStash(sessionId: string): void {
  try {
    sessionStorage.removeItem(startStashKey(sessionId));
  } catch {}
}
