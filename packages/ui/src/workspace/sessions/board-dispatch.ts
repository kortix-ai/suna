/**
 * The agent board's dispatch input and keyboard, as pure functions.
 *
 * The input does two jobs, as Claude Code's agent view does. Filter tokens at
 * the start (`s:working`, `a:reviewer`) narrow the board. Anything else is a
 * prompt: Enter starts a new session with it. `@agent` as the first word, or a
 * first word that names a project agent, runs that agent.
 */
import type { SessionBoardState } from '@kortix/sdk';

/** Claude Code rejects a dispatch under 4 characters with "Too short". */
export const DISPATCH_MIN_CHARS = 4;

const STATE_WORDS: Record<string, readonly SessionBoardState[]> = {
  working: ['working'],
  needs_input: ['needs_input'],
  input: ['needs_input'],
  blocked: ['needs_input'],
  idle: ['idle'],
  completed: ['completed'],
  done: ['completed'],
  failed: ['failed'],
  stopped: ['stopped'],
  ended: ['failed', 'stopped'],
};

export interface BoardInput {
  /** States from `s:` tokens; empty for none. */
  states: SessionBoardState[];
  /** Agents from `a:` tokens; empty for none. */
  agents: string[];
  /** The text after the filter tokens: the prompt to dispatch, or nothing. */
  rest: string;
}

/** Split the leading `s:` / `a:` filter tokens off the input. An unknown state word is prompt text. */
export function parseBoardInput(input: string): BoardInput {
  const states: SessionBoardState[] = [];
  const agents: string[] = [];
  const words = input.trimStart().split(/(\s+)/);
  let index = 0;
  for (; index < words.length; index += 2) {
    const word = words[index] ?? '';
    const state = /^s:(\S+)$/i.exec(word)?.[1]?.toLowerCase();
    const agent = /^a:(\S+)$/i.exec(word)?.[1];
    if (state && STATE_WORDS[state]) {
      for (const value of STATE_WORDS[state]!) if (!states.includes(value)) states.push(value);
    } else if (agent) {
      if (!agents.includes(agent)) agents.push(agent);
    } else break;
  }
  return { states, agents, rest: words.slice(index).join('').trim() };
}

export type DispatchResult =
  | { kind: 'empty' }
  | { kind: 'too_short' }
  | { kind: 'dispatch'; prompt: string; agent?: string };

/**
 * What Enter does with the prompt part of the input. `agents` is the project's
 * agent names; a match is case-insensitive and returns the agent's own spelling.
 */
export function parseDispatch(text: string, agents: readonly string[]): DispatchResult {
  const trimmed = text.trim();
  if (!trimmed) return { kind: 'empty' };
  if (trimmed.length < DISPATCH_MIN_CHARS) return { kind: 'too_short' };
  const [first = '', ...more] = trimmed.split(/\s+/);
  const named = first.startsWith('@') ? first.slice(1) : first;
  const agent = agents.find((name) => name.toLowerCase() === named.toLowerCase());
  const rest = trimmed.slice(first.length).trim();
  if (agent && more.length > 0) {
    // The prompt the agent gets must stand on its own: "@reviewer hi" is still too short.
    if (rest.length < DISPATCH_MIN_CHARS) return { kind: 'too_short' };
    return { kind: 'dispatch', prompt: rest, agent };
  }
  return { kind: 'dispatch', prompt: trimmed };
}

export type BoardKeyAction = 'up' | 'down' | 'peek' | 'open' | 'stop' | 'close';

/**
 * The board's keys when the list has focus: ↑/↓ move, Space opens or closes the
 * peek, Enter opens the session, x stops it, Escape closes the peek. A key typed
 * into a field, or with a modifier, belongs to the field or the browser.
 */
export function boardKeyAction(
  event: Pick<KeyboardEvent, 'key' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>,
  target: { tagName?: string; isContentEditable?: boolean } | null,
): BoardKeyAction | null {
  if (event.altKey || event.ctrlKey || event.metaKey) return null;
  const tag = target?.tagName ?? '';
  if (target?.isContentEditable || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return null;
  // A focused button or link inside a row answers Enter and Space itself.
  if ((tag === 'BUTTON' || tag === 'A') && (event.key === 'Enter' || event.key === ' ')) return null;
  switch (event.key) {
    case 'ArrowUp':
      return 'up';
    case 'ArrowDown':
      return 'down';
    case ' ':
      return 'peek';
    case 'Enter':
      return 'open';
    case 'x':
      return event.shiftKey ? null : 'stop';
    case 'Escape':
      return 'close';
    default:
      return null;
  }
}

/** The row the selection moves to; it stays inside the list. */
export function moveBoardSelection(order: readonly string[], current: string | null, step: 1 | -1): string | null {
  if (order.length === 0) return null;
  const index = current ? order.indexOf(current) : -1;
  if (index === -1) return step === 1 ? order[0]! : order[order.length - 1]!;
  return order[Math.min(order.length - 1, Math.max(0, index + step))]!;
}

/** `?view=board` is the board; any other view (or none) is the list. */
export type SessionsLayout = 'list' | 'board';
export const sessionsLayoutOf = (view: string | null | undefined): SessionsLayout => (view === 'board' ? 'board' : 'list');

/** The query string after the List/Board toggle: `view=board`, or no `view` for the list. */
export function withSessionsLayout(search: string, layout: SessionsLayout): string {
  const params = new URLSearchParams(search);
  if (layout === 'board') params.set('view', 'board');
  else if (params.get('view') === 'board') params.delete('view');
  return params.toString();
}
