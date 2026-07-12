/**
 * Curated Runtime event union for building a product chat UI — framework-free.
 *
 * `RuntimeEvent` (`./event-stream.ts`) is the FULL raw wire union: ~50+
 * variants covering LSP, PTY, worktrees, plugins, projects, MCP, installation,
 * and more. A chat surface only ever cares about a small slice of that —
 * message/part updates, session status, questions, permissions, todos, and
 * connection health. `narrowChatEvent` filters + reshapes the raw stream down
 * to `KortixChatEvent`, so a host's dispatch switch only has to handle events
 * that actually matter to chat, each carrying a purpose-shaped payload
 * instead of the raw untyped `properties` bag.
 *
 * `heartbeat-gap` has no wire representation of its own — `openEventStream`'s
 * `onGapRehydrate(gapMs)` callback fires out-of-band when the SSE stream
 * reconnects after a gap large enough that cached state may be stale. Build
 * it with `heartbeatGapEvent(gapMs)` and dispatch it the same way as
 * `narrowChatEvent`'s output:
 *
 * ```ts
 * openEventStream({
 *   client,
 *   onEvent: (e) => {
 *     const chatEvent = narrowChatEvent(e);
 *     if (chatEvent) dispatch(chatEvent);
 *   },
 *   onGapRehydrate: (gapMs) => dispatch(heartbeatGapEvent(gapMs)),
 * });
 * ```
 */

import type { Message, Part, QuestionAnswer, SessionStatus, Todo } from '../runtime/client';
import type { RuntimeEvent } from './event-stream';

export interface KortixChatEventMessageUpdated {
  type: 'message.updated';
  sessionID: string;
  message: Message;
}

export interface KortixChatEventMessageRemoved {
  type: 'message.removed';
  sessionID: string;
  messageID: string;
}

export interface KortixChatEventPartUpdated {
  type: 'message.part.updated';
  sessionID: string;
  part: Part;
}

export interface KortixChatEventPartRemoved {
  type: 'message.part.removed';
  sessionID: string;
  messageID: string;
  partID: string;
}

export interface KortixChatEventSessionStatus {
  type: 'session.status';
  sessionID: string;
  status: SessionStatus;
}

export interface KortixChatEventSessionIdle {
  type: 'session.idle';
  sessionID: string;
}

export interface KortixChatEventSessionError {
  type: 'session.error';
  sessionID?: string;
  error?: unknown;
}

export interface KortixChatQuestionOption {
  label: string;
  description: string;
}

export interface KortixChatQuestionInfo {
  question: string;
  header: string;
  options: KortixChatQuestionOption[];
  multiple?: boolean;
  custom?: boolean;
}

export interface KortixChatToolRef {
  messageID: string;
  callID: string;
}

export interface KortixChatEventQuestionAsked {
  type: 'question.asked';
  sessionID: string;
  requestID: string;
  questions: KortixChatQuestionInfo[];
  tool?: KortixChatToolRef;
}

/** Merges the wire's `question.replied` / `question.rejected` events — a host
 *  usually just needs to know "this pending question resolved" plus how. */
export interface KortixChatEventQuestionAnswered {
  type: 'question.answered';
  sessionID: string;
  requestID: string;
  outcome: 'replied' | 'rejected';
  answers?: QuestionAnswer[];
}

export interface KortixChatEventPermissionAsked {
  type: 'permission.asked';
  sessionID: string;
  requestID: string;
  permission: string;
  patterns: string[];
  tool?: KortixChatToolRef;
}

export interface KortixChatEventPermissionReplied {
  type: 'permission.replied';
  sessionID: string;
  requestID: string;
  reply: 'once' | 'always' | 'reject';
}

export interface KortixChatEventTodoUpdated {
  type: 'todo.updated';
  sessionID: string;
  todos: Todo[];
}

/** Fired once per SSE (re)connect — a host can use it to clear a "reconnecting…" banner. */
export interface KortixChatEventConnection {
  type: 'connection';
  status: 'connected';
}

/** Synthetic — see the module doc comment. Not derived from `narrowChatEvent`;
 *  built directly from `openEventStream`'s `onGapRehydrate(gapMs)`. */
export interface KortixChatEventHeartbeatGap {
  type: 'heartbeat-gap';
  gapMs: number;
}

export type KortixChatEvent =
  | KortixChatEventMessageUpdated
  | KortixChatEventMessageRemoved
  | KortixChatEventPartUpdated
  | KortixChatEventPartRemoved
  | KortixChatEventSessionStatus
  | KortixChatEventSessionIdle
  | KortixChatEventSessionError
  | KortixChatEventQuestionAsked
  | KortixChatEventQuestionAnswered
  | KortixChatEventPermissionAsked
  | KortixChatEventPermissionReplied
  | KortixChatEventTodoUpdated
  | KortixChatEventConnection
  | KortixChatEventHeartbeatGap;

/** Build the synthetic heartbeat-gap chat event from `openEventStream`'s `onGapRehydrate` callback. */
export function heartbeatGapEvent(gapMs: number): KortixChatEventHeartbeatGap {
  return { type: 'heartbeat-gap', gapMs };
}

/**
 * Narrow a raw `RuntimeEvent` down to the curated `KortixChatEvent` union a
 * chat UI needs, reshaping `properties` into a purpose-built payload.
 *
 * Returns `null` for every event outside the curated set (LSP, PTY,
 * worktrees, plugins, projects, MCP, installation, session lifecycle CRUD,
 * …) — callers should treat `null` as "not a chat event, ignore" rather than
 * an error; this is a deliberate filter, not an exhaustive switch.
 */
export function narrowChatEvent(event: RuntimeEvent): KortixChatEvent | null {
  switch (event.type) {
    case 'message.updated':
      return {
        type: 'message.updated',
        sessionID: event.properties.sessionID,
        message: event.properties.info,
      };

    case 'message.removed':
      return {
        type: 'message.removed',
        sessionID: event.properties.sessionID,
        messageID: event.properties.messageID,
      };

    case 'message.part.updated':
      return {
        type: 'message.part.updated',
        sessionID: event.properties.sessionID,
        part: event.properties.part,
      };

    case 'message.part.removed':
      return {
        type: 'message.part.removed',
        sessionID: event.properties.sessionID,
        messageID: event.properties.messageID,
        partID: event.properties.partID,
      };

    case 'session.status':
      return {
        type: 'session.status',
        sessionID: event.properties.sessionID,
        status: event.properties.status,
      };

    case 'session.idle':
      return { type: 'session.idle', sessionID: event.properties.sessionID };

    case 'session.error':
      return {
        type: 'session.error',
        sessionID: event.properties.sessionID,
        error: event.properties.error,
      };

    case 'question.asked':
      return {
        type: 'question.asked',
        sessionID: event.properties.sessionID,
        requestID: event.properties.id,
        questions: event.properties.questions,
        tool: event.properties.tool,
      };

    case 'question.replied':
      return {
        type: 'question.answered',
        sessionID: event.properties.sessionID,
        requestID: event.properties.requestID,
        outcome: 'replied',
        answers: event.properties.answers,
      };

    case 'question.rejected':
      return {
        type: 'question.answered',
        sessionID: event.properties.sessionID,
        requestID: event.properties.requestID,
        outcome: 'rejected',
      };

    case 'permission.asked':
      return {
        type: 'permission.asked',
        sessionID: event.properties.sessionID,
        requestID: event.properties.id,
        permission: event.properties.permission,
        patterns: event.properties.patterns,
        tool: event.properties.tool,
      };

    case 'permission.replied':
      return {
        type: 'permission.replied',
        sessionID: event.properties.sessionID,
        requestID: event.properties.requestID,
        reply: event.properties.reply,
      };

    case 'todo.updated':
      return {
        type: 'todo.updated',
        sessionID: event.properties.sessionID,
        todos: event.properties.todos,
      };

    case 'server.connected':
      return { type: 'connection', status: 'connected' };

    default:
      return null;
  }
}
