/**
 * session-sandbox — when the project screen (components/session/ProjectScreen)
 * keeps, leaves, or waits for the switched-in session sandbox.
 *
 * The SandboxContext override is the sandbox of the open session. The live
 * event stream connects to it, and SessionPage reads it. It is a React state
 * update, while the open thread (tab store `activeSessionId`) is a zustand
 * update: the two can commit in different renders.
 *
 * Pure: no React, React Native, or expo imports (unit-tested under bun test).
 */

/** What the project view shows, from the tab store. */
export interface SessionContentState {
  activeSessionId: string | null;
  activePageId: string | null;
}

/**
 * A thread or a page is on screen, so the switched-in sandbox
 * stays. A page opened from a thread reads it. A connecting session does not
 * count: the connecting view needs no sandbox, and a sandbox kept for it would
 * leave the stream on the previous session while the next one connects.
 */
export function showsSessionContent({
  activeSessionId,
  activePageId,
}: SessionContentState): boolean {
  return !!activeSessionId || !!activePageId;
}

/**
 * The project screen regains focus (a root screen such as Settings closed).
 * Leave a sandbox switched in elsewhere (Settings → Instances) unless session
 * content is on screen or a session open is in progress: that open switches
 * its own sandbox in.
 */
export function leaveSandboxOnFocus(
  state: SessionContentState & { connectInProgress: boolean }
): boolean {
  return !state.connectInProgress && !showsSessionContent(state);
}

/** The thread the connect flow opened, and the exact sandbox URL it switched in. */
export interface OpenedThread {
  sessionId: string;
  sandboxUrl: string;
}

/**
 * The thread may render: the context holds its sandbox. For the thread the
 * connect flow opened, the context `sandboxUrl` must equal the exact value
 * switched in (string equality, never a prefix). A thread opened any other way,
 * or whose record already matched once (pendingOpenedThread), renders on the
 * context sandbox.
 */
export function threadSandboxReady({
  activeSessionId,
  sandboxUrl,
  openedThread,
}: {
  activeSessionId: string | null;
  sandboxUrl: string | undefined;
  openedThread: OpenedThread | null;
}): boolean {
  if (!activeSessionId) return false;
  if (openedThread?.sessionId !== activeSessionId) return true;
  return sandboxUrl === openedThread.sandboxUrl;
}

/**
 * The record to keep after a committed render. The gate holds only while the
 * switch is pending: the first render where the context holds the recorded
 * sandbox for this thread drops the record. A later override change (Settings
 * → Instances from the thread) then keeps the thread mounted.
 */
export function pendingOpenedThread({
  activeSessionId,
  sandboxUrl,
  openedThread,
}: {
  activeSessionId: string | null;
  sandboxUrl: string | undefined;
  openedThread: OpenedThread | null;
}): OpenedThread | null {
  if (
    openedThread &&
    activeSessionId &&
    openedThread.sessionId === activeSessionId &&
    sandboxUrl === openedThread.sandboxUrl
  ) {
    return null;
  }
  return openedThread;
}
