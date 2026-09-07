/**
 * S0.5 — pi's event stream, reshaped into the wire events the Kortix frontend
 * already consumes.
 *
 * The gate asks one question: can the frontend we already have run on this
 * harness without being rewritten? The answer is decided by whether every
 * event `packages/sdk` narrows and classifies has a pi source.
 *
 * The wire shape is OpenCode's `{ type, properties }`, because that is what
 * `narrowChatEvent()` takes. The adapter is therefore not "a new protocol" —
 * it is pi speaking the protocol the SDK already parses, which is what keeps
 * `useSession` and every chat surface unchanged.
 *
 * CORRECTION TO AN EARLIER FINDING IN THIS SPIKE. I previously recorded that
 * `Agent.subscribe` emits no text deltas and that a streaming frontend would
 * have to tap the pi-ai layer. That was wrong, and measuring it is what
 * corrected it: a 30-word answer produces 21 `message_update` events carrying
 * `text_start` / 19x `text_delta` / `text_end` in `assistantMessageEvent`.
 * Deltas are available at the Agent layer. No pi-ai tapping is required.
 */

import type { AssistantMessage } from '@opencode-ai/sdk/v2';

type Wire = {
  type: string;
  properties: Record<string, unknown>;
  /**
   * Fold into the transcript but do NOT put on the event bus. Used for the
   * cumulative text snapshot that accompanies a `message.part.delta`: the
   * transcript needs the full string, subscribers need the append, and a
   * subscriber that got both would render the text twice.
   */
  transcriptOnly?: boolean;
};

const now = () => Date.now();

/** Flatten pi's AgentToolResult into the plain text the UI expects. */
function toolOutputText(result: any): string {
  if (typeof result === 'string') return result;
  const blocks = result?.content;
  if (Array.isArray(blocks)) {
    const text = blocks
      .filter((c: any) => c?.type === 'text')
      .map((c: any) => c.text)
      .join('');
    if (text) return text;
  }
  return result == null ? '' : JSON.stringify(result);
}

/** OpenCode part ids are stable per (messageId, index). */
const partId = (messageId: string, index: number) => `${messageId}-p${index}`;

export interface AdapterOptions {
  sessionID: string;
  /** Stable id for the assistant message currently being streamed. */
  messageId?: () => string;
  /**
   * Session-scoped id mint. Without it ids restart at `msg-1` per adapter
   * instance, so two turns through two adapters collide — and the id ORDER is
   * load-bearing (the transcript sorts by it, and OpenCode's own id order is
   * how an answered prompt is detected). The worker passes its surface's
   * zero-padded counter.
   */
  mintMessageId?: () => string;
  /** The user message this assistant run answers. Read once at message start. */
  parentMessageId?: () => string | null;
  /** Public compiled model identity. It hides the gateway's provider transport. */
  model?: { providerID: string; modelID: string } | null;
  agent?: string;
  mode?: string;
  workspace?: string;
  /** Injectable wall clock for deterministic duration-contract tests. */
  now?: () => number;
}

export type AssistantContractFields = Pick<
  AssistantMessage,
  'agent' | 'mode' | 'path' | 'cost' | 'tokens'
>;

export interface AssistantContractOptions {
  agent?: string;
  mode?: string;
  workspace?: string;
}

function finiteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function assistantContractFields(
  usage: any,
  options: AssistantContractOptions = {},
): AssistantContractFields {
  const agent = options.agent ?? 'build';
  const workspace = options.workspace ?? '/workspace';
  return {
    agent,
    mode: options.mode ?? agent,
    path: { cwd: workspace, root: workspace },
    cost: finiteNumber(usage?.cost?.total),
    tokens: {
      input: finiteNumber(usage?.input),
      output: finiteNumber(usage?.output),
      reasoning: finiteNumber(usage?.reasoning),
      cache: {
        read: finiteNumber(usage?.cacheRead),
        write: finiteNumber(usage?.cacheWrite),
      },
    },
  };
}

export function assistantMessageError(message: {
  stopReason?: unknown;
  errorMessage?: unknown;
}): AssistantMessage['error'] | undefined {
  const detail =
    typeof message.errorMessage === 'string' && message.errorMessage.trim()
      ? message.errorMessage
      : null;
  if (message.stopReason === 'aborted') {
    return {
      name: 'MessageAbortedError',
      data: { message: detail ?? 'The message was aborted' },
    };
  }
  if (message.stopReason === 'error') {
    return {
      name: 'UnknownError',
      data: { message: detail ?? 'The model request failed' },
    };
  }
  if (message.stopReason === 'length') {
    return {
      name: 'MessageOutputLengthError',
      data: {},
    };
  }
  return undefined;
}

/**
 * Translate one pi `AgentEvent` into zero or more Kortix wire events.
 *
 * Stateful across a turn: parts accumulate, so a `text_delta` emits the FULL
 * text so far, matching OpenCode's semantics (`message.part.updated` carries
 * the whole part, not the delta).
 */
export class ChatEventAdapter {
  private readonly sessionID: string;
  private readonly mint?: () => string;
  private readonly fixedMessageId?: () => string;
  private readonly parent?: () => string | null;
  private readonly model: { providerID: string; modelID: string } | null;
  private readonly agent: string;
  private readonly mode: string;
  private readonly workspace: string;
  private readonly now: () => number;
  private messageSeq = 0;
  private currentMessageId = '';
  private currentParentId: string | null = null;
  private currentMessageCreatedAt = 0;
  private textIndex = new Map<string, number>();
  private toolIndex = new Map<
    string,
    { partId: string; name: string; input: unknown; startedAt: number }
  >();
  private accum = new Map<string, string>();
  private partCount = 0;
  private partStartedAt = new Map<string, number>();

  constructor(opts: AdapterOptions) {
    this.sessionID = opts.sessionID;
    this.mint = opts.mintMessageId;
    this.fixedMessageId = opts.messageId;
    this.parent = opts.parentMessageId;
    this.model = opts.model ?? null;
    this.agent = opts.agent ?? 'build';
    this.mode = opts.mode ?? this.agent;
    this.workspace = opts.workspace ?? '/workspace';
    this.now = opts.now ?? now;
  }

  private nextPart(): string {
    return partId(this.currentMessageId, this.partCount++);
  }

  translate(event: any): Wire[] {
    const sessionID = this.sessionID;
    switch (event.type) {
      case 'agent_start':
        // `busy`, not `running`. OpenCode's SessionStatus union is exactly
        // `idle | busy | retry`, and this adapter's whole job is to make pi
        // look like OpenCode. `running` is not in that union, so every
        // consumer switching on it fell through to its default: the SDK read
        // it as IDLE and hid the working indicator and the Stop button for the
        // entire turn while the agent was still generating.
        return [{ type: 'session.status', properties: { sessionID, status: { type: 'busy' } } }];

      case 'message_start': {
        // Only ASSISTANT messages translate. The worker publishes the USER
        // message itself at prompt time (pi's user message_start rendered an
        // empty duplicate bubble — dev session ae3a07fc), and pi's 'toolResult'
        // messages are already carried as tool PARTS on the assistant message
        // (dev session 7f218b0a rendered a stray toolResult row).
        if ((event.message?.role ?? 'assistant') !== 'assistant') return [];
        this.currentMessageId =
          this.fixedMessageId?.() ?? (this.mint ? this.mint() : `msg-${++this.messageSeq}`);
        this.currentParentId = this.parent?.() ?? null;
        this.currentMessageCreatedAt = this.now();
        this.partCount = 0;
        this.textIndex.clear();
        this.accum.clear();
        this.partStartedAt.clear();
        return [
          {
            type: 'message.updated',
            properties: {
              sessionID,
              info: {
                id: this.currentMessageId,
                role: event.message?.role ?? 'assistant',
                sessionID,
                ...(this.currentParentId ? { parentID: this.currentParentId } : {}),
                time: { created: this.currentMessageCreatedAt },
                modelID: this.model?.modelID ?? event.message?.model,
                providerID: this.model?.providerID ?? event.message?.provider,
                ...assistantContractFields(event.message?.usage, {
                  agent: this.agent,
                  mode: this.mode,
                  workspace: this.workspace,
                }),
              },
            },
          },
        ];
      }

      case 'message_update': {
        const inner = event.assistantMessageEvent;
        if (!inner) return [];
        // text ------------------------------------------------------------
        if (
          inner.type === 'text_start' ||
          inner.type === 'text_delta' ||
          inner.type === 'text_end'
        ) {
          const key = `text:${inner.contentIndex ?? 0}`;
          if (!this.textIndex.has(key)) this.textIndex.set(key, this.partCount++);
          const id = partId(this.currentMessageId, this.textIndex.get(key)!);
          const prev = this.accum.get(id) ?? '';
          const next =
            inner.type === 'text_delta' ? prev + (inner.delta ?? '') : (inner.content ?? prev);
          this.accum.set(id, next);
          return this.streamingTextFrames({
            id,
            sessionID,
            partType: 'text',
            field: 'text',
            full: next,
            delta: inner.type === 'text_delta' ? (inner.delta ?? '') : null,
          });
        }
        // thinking ---------------------------------------------------------
        if (
          inner.type === 'thinking_start' ||
          inner.type === 'thinking_delta' ||
          inner.type === 'thinking_end'
        ) {
          const key = `think:${inner.contentIndex ?? 0}`;
          if (!this.textIndex.has(key)) this.textIndex.set(key, this.partCount++);
          const id = partId(this.currentMessageId, this.textIndex.get(key)!);
          const partStart = this.partStartedAt.get(id) ?? this.now();
          this.partStartedAt.set(id, partStart);
          const prev = this.accum.get(id) ?? '';
          const next =
            inner.type === 'thinking_delta' ? prev + (inner.delta ?? '') : (inner.content ?? prev);
          this.accum.set(id, next);
          return this.streamingTextFrames({
            id,
            sessionID,
            partType: 'reasoning',
            field: 'text',
            full: next,
            delta: inner.type === 'thinking_delta' ? (inner.delta ?? '') : null,
            time: {
              start: partStart,
              ...(inner.type === 'thinking_end' ? { end: this.now() } : {}),
            },
          });
        }
        return [];
      }

      case 'tool_execution_start': {
        const id = this.nextPart();
        const startedAt = this.now();
        this.toolIndex.set(event.toolCallId, {
          partId: id,
          name: event.toolName,
          input: event.args,
          startedAt,
        });
        return [
          this.toolPart(id, event.toolName, {
            status: 'running',
            input: event.args,
            time: { start: startedAt },
          }),
        ];
      }

      case 'tool_execution_update': {
        const t = this.toolIndex.get(event.toolCallId);
        if (!t) return [];
        return [
          this.toolPart(t.partId, t.name, {
            status: 'running',
            input: t.input,
            time: { start: t.startedAt },
          }),
        ];
      }

      case 'tool_execution_end': {
        const t = this.toolIndex.get(event.toolCallId);
        if (!t) return [];
        // pi returns AgentToolResult { content: [{type:'text',text}], details }.
        // The UI's shell/file view-models read `state.output` as the command's
        // own output, so hand them the text — a JSON envelope would render as
        // a blob where stdout belongs.
        const output = toolOutputText(event.result);
        const endedAt = this.now();
        return [
          this.toolPart(
            t.partId,
            t.name,
            event.isError
              ? {
                  status: 'error',
                  input: t.input,
                  error: output,
                  time: { start: t.startedAt, end: endedAt },
                }
              : {
                  status: 'completed',
                  input: t.input,
                  output,
                  title: t.name,
                  metadata: {},
                  time: { start: t.startedAt, end: endedAt },
                },
          ),
        ];
      }

      case 'message_end': {
        if ((event.message?.role ?? 'assistant') !== 'assistant') return [];
        // These two JSON fields travel with Pi's durable message. They let a
        // restarted worker rebuild the exact wire transcript instead of
        // minting new ids and breaking parent relationships on every boot.
        if (event.message && typeof event.message === 'object') {
          event.message.kortixWireMessageId = this.currentMessageId;
          if (this.currentParentId) event.message.kortixParentMessageId = this.currentParentId;
        }
        const stop = event.message?.stopReason;
        const terminalError = assistantMessageError(event.message ?? {});
        const completedAt = this.now();
        const out: Wire[] = [
          {
            type: 'message.updated',
            properties: {
              sessionID,
              info: {
                id: this.currentMessageId,
                role: event.message?.role ?? 'assistant',
                sessionID,
                ...(this.currentParentId ? { parentID: this.currentParentId } : {}),
                time: { created: this.currentMessageCreatedAt, completed: completedAt },
                modelID: this.model?.modelID ?? event.message?.model,
                providerID: this.model?.providerID ?? event.message?.provider,
                ...assistantContractFields(event.message?.usage, {
                  agent: this.agent,
                  mode: this.mode,
                  workspace: this.workspace,
                }),
                ...(terminalError ? { error: terminalError } : {}),
              },
            },
          },
        ];
        if (stop === 'error' || stop === 'length') {
          out.push({
            type: 'session.error',
            properties: {
              sessionID,
              error: terminalError,
            },
          });
        }
        return out;
      }

      case 'agent_end':
        return [
          { type: 'session.status', properties: { sessionID, status: { type: 'idle' } } },
          { type: 'session.idle', properties: { sessionID } },
        ];

      default:
        return [];
    }
  }

  /**
   * One streamed text chunk, as BOTH shapes — because they are for different
   * consumers and must not be applied by the same one.
   *
   * pi hands us a true `text_delta` (its documented streaming contract:
   * `message_update` -> `assistantMessageEvent.text_delta.delta`). We used to
   * throw the delta away and republish the whole accumulated string as a
   * cumulative `message.part.updated`. That is correct but it is the SNAPSHOT
   * path, and the web client only re-renders eagerly off `message.part.delta`
   * (`applyPartDelta` / `deltaActiveParts` in packages/sdk sync-store) — the
   * path OpenCode drives. So a pi answer arrived as one lump at the end:
   * measured on pi.kortix.com 2026-08-29, the worker emitted 183 incremental
   * frames over 31 s while the browser painted the block ONCE, already 94%
   * complete.
   *
   * Emitting both onto the bus would double-count: the snapshot REPLACES the
   * part text and the delta APPENDS to it. So they are split by destination —
   * `transcriptOnly` frames never reach the bus:
   *
   *   bus        <- message.part.delta   (append; drives incremental paint)
   *   transcript <- message.part.updated (authoritative full text for REST
   *                                       reads and for `since=` resync)
   *
   * A chunk with no delta (text_start / text_end) carries no append, so it
   * publishes the snapshot normally — which also repairs any drift if a delta
   * was ever dropped, since `upsertPart` accepts prefix growth.
   */
  private streamingTextFrames(input: {
    id: string;
    sessionID: string;
    partType: 'text' | 'reasoning';
    field: string;
    full: string;
    delta: string | null;
    time?: { start: number; end?: number };
  }): Wire[] {
    const snapshot: Wire = {
      type: 'message.part.updated',
      properties: {
        sessionID: input.sessionID,
        time: now(),
        part: {
          id: input.id,
          messageID: this.currentMessageId,
          sessionID: input.sessionID,
          type: input.partType,
          text: input.full,
          ...(input.time ? { time: input.time } : {}),
        },
      },
    };
    if (!input.delta) return [snapshot];
    return [
      { ...snapshot, transcriptOnly: true },
      {
        type: 'message.part.delta',
        properties: {
          sessionID: input.sessionID,
          messageID: this.currentMessageId,
          partID: input.id,
          field: input.field,
          delta: input.delta,
        },
      },
    ];
  }

  private toolPart(id: string, tool: string, state: Record<string, unknown>): Wire {
    return {
      type: 'message.part.updated',
      properties: {
        sessionID: this.sessionID,
        time: now(),
        part: {
          id,
          messageID: this.currentMessageId,
          sessionID: this.sessionID,
          type: 'tool',
          tool,
          callID: id,
          state,
        },
      },
    };
  }
}
