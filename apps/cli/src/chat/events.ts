/**
 * Raw OpenCode bus event → the curated slice a chat surface needs.
 *
 * Deliberately mirrors `packages/sdk/src/core/stream/chat-events.ts` variant
 * for variant (same `type` strings, same field names) so the two files stay
 * recognizable as the same contract even though the CLI cannot import the SDK
 * (see the header of `../api/sandbox-events.ts` for why).
 *
 * Pure: no I/O, no imports beyond types. An unknown event type narrows to
 * `null` — this is a FILTER, not an exhaustive switch, so a new server-side
 * event can never crash the client.
 */

import type { SandboxEvent } from '../api/sandbox-events.ts';

/** The shape of a message part as it arrives on the bus. Wider than
 *  `OpencodePart` in the proxy client because a streaming part also carries the
 *  ids needed to key it, and tool state carries timing/errors. */
export interface ChatPart {
  id?: string;
  messageID?: string;
  sessionID?: string;
  type: string;
  text?: string;
  synthetic?: boolean;
  tool?: string;
  callID?: string;
  filename?: string;
  mime?: string;
  state?: ChatPartState;
}

export interface ChatPartState {
  status?: string;
  input?: unknown;
  output?: string;
  title?: string;
  error?: string;
  time?: { start?: number; end?: number };
}

export interface ChatMessageInfo {
  id?: string;
  role?: string;
  sessionID?: string;
  parentID?: string;
  time?: { created?: number; completed?: number };
  error?: { name?: string; message?: string } | null;
}

export interface ChatQuestionOption {
  label: string;
  value?: string;
  description?: string;
  hint?: string;
}

export interface ChatQuestionInfo {
  question: string;
  header?: string;
  options?: ChatQuestionOption[];
  multiple?: boolean;
  custom?: boolean;
}

export interface ChatToolRef {
  messageID: string;
  callID: string;
}

export type ChatEvent =
  | { type: 'message.updated'; sessionID: string; message: ChatMessageInfo }
  | { type: 'message.removed'; sessionID: string; messageID: string }
  | { type: 'message.part.updated'; sessionID: string; part: ChatPart }
  | { type: 'message.part.removed'; sessionID: string; messageID: string; partID: string }
  | { type: 'session.status'; sessionID: string; status: unknown }
  | { type: 'session.idle'; sessionID: string }
  | { type: 'session.error'; sessionID?: string; error?: unknown }
  | {
      type: 'question.asked';
      sessionID: string;
      requestID: string;
      questions: ChatQuestionInfo[];
      tool?: ChatToolRef;
    }
  | {
      type: 'question.answered';
      sessionID: string;
      requestID: string;
      outcome: 'replied' | 'rejected';
    }
  | {
      type: 'permission.asked';
      sessionID: string;
      requestID: string;
      permission: string;
      patterns: string[];
      tool?: ChatToolRef;
    }
  | {
      type: 'permission.replied';
      sessionID: string;
      requestID: string;
      reply: 'once' | 'always' | 'reject';
    }
  | { type: 'todo.updated'; sessionID: string; todos: unknown[] }
  | { type: 'connection'; status: 'connected' }
  /** Synthetic — built from the stream's `onGapRehydrate`, no wire form. */
  | { type: 'heartbeat-gap'; gapMs: number };

export function heartbeatGapEvent(gapMs: number): ChatEvent {
  return { type: 'heartbeat-gap', gapMs };
}

function props(event: SandboxEvent): Record<string, unknown> {
  return (event.properties ?? {}) as Record<string, unknown>;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Narrow a raw bus event to `ChatEvent`, or null for everything outside the
 * curated set (LSP, PTY, worktrees, plugins, projects, MCP, installation, …).
 */
export function narrowChatEvent(event: SandboxEvent): ChatEvent | null {
  const p = props(event);
  switch (event.type) {
    case 'message.updated':
      return {
        type: 'message.updated',
        sessionID: str(p.sessionID),
        message: (p.info ?? {}) as ChatMessageInfo,
      };
    case 'message.removed':
      return {
        type: 'message.removed',
        sessionID: str(p.sessionID),
        messageID: str(p.messageID),
      };
    case 'message.part.updated': {
      const part = p.part as ChatPart | undefined;
      if (!part || typeof part.type !== 'string') return null;
      return {
        type: 'message.part.updated',
        sessionID: str(p.sessionID) || str(part.sessionID),
        part,
      };
    }
    case 'message.part.removed':
      return {
        type: 'message.part.removed',
        sessionID: str(p.sessionID),
        messageID: str(p.messageID),
        partID: str(p.partID),
      };
    case 'session.status':
      return { type: 'session.status', sessionID: str(p.sessionID), status: p.status };
    case 'session.idle':
      return { type: 'session.idle', sessionID: str(p.sessionID) };
    case 'session.error':
      return {
        type: 'session.error',
        sessionID: typeof p.sessionID === 'string' ? p.sessionID : undefined,
        error: p.error,
      };
    case 'question.asked':
      return {
        type: 'question.asked',
        sessionID: str(p.sessionID),
        requestID: str(p.id),
        questions: Array.isArray(p.questions) ? (p.questions as ChatQuestionInfo[]) : [],
        tool: p.tool as ChatToolRef | undefined,
      };
    case 'question.replied':
      return {
        type: 'question.answered',
        sessionID: str(p.sessionID),
        requestID: str(p.requestID),
        outcome: 'replied',
      };
    case 'question.rejected':
      return {
        type: 'question.answered',
        sessionID: str(p.sessionID),
        requestID: str(p.requestID),
        outcome: 'rejected',
      };
    case 'permission.asked':
      return {
        type: 'permission.asked',
        sessionID: str(p.sessionID),
        requestID: str(p.id),
        permission: str(p.permission),
        patterns: Array.isArray(p.patterns) ? (p.patterns as string[]) : [],
        tool: p.tool as ChatToolRef | undefined,
      };
    case 'permission.replied':
      return {
        type: 'permission.replied',
        sessionID: str(p.sessionID),
        requestID: str(p.requestID),
        reply: (str(p.reply) || 'once') as 'once' | 'always' | 'reject',
      };
    case 'todo.updated':
      return {
        type: 'todo.updated',
        sessionID: str(p.sessionID),
        todos: Array.isArray(p.todos) ? p.todos : [],
      };
    case 'server.connected':
      return { type: 'connection', status: 'connected' };
    default:
      return null;
  }
}
