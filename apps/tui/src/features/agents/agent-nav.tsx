/**
 * How any row in the TUI opens another agent's session.
 *
 * Peek, then switch: `peek(id)` draws a live, read-only view of that session over
 * the transcript (watch it, steer it, stop it; Esc goes back), and `switchTo(id)`
 * makes it the open session. `parent()` goes back up from a child. Rows anywhere
 * (an `agent` call, a workflow agent, the /agents panel) call these and never
 * touch app state themselves.
 *
 * `app.tsx` provides the real one; without a provider every call is a no-op, so a
 * component renders in a test without the app around it.
 */

import { type ReactNode, createContext, useContext } from 'react';

export interface PeekTarget {
  sessionId: string;
  /** What the row called it: the agent's label, a workflow agent's name. */
  title?: string;
}

export interface AgentNav {
  /** The session open in the TUI, or null on the empty state. */
  currentSessionId: string | null;
  /** The session being peeked at, or null. */
  peeking: PeekTarget | null;
  peek(target: PeekTarget): void;
  closePeek(): void;
  /** Open this session as the main one. */
  switchTo(sessionId: string): void;
}

const NONE: AgentNav = {
  currentSessionId: null,
  peeking: null,
  peek: () => {},
  closePeek: () => {},
  switchTo: () => {},
};

const AgentNavContext = createContext<AgentNav>(NONE);

export function AgentNavProvider({ value, children }: { value: AgentNav; children: ReactNode }) {
  return <AgentNavContext.Provider value={value}>{children}</AgentNavContext.Provider>;
}

export function useAgentNav(): AgentNav {
  return useContext(AgentNavContext);
}
