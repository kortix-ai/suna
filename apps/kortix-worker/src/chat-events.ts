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

type Wire = { type: string; properties: Record<string, unknown> };

const now = () => Date.now();

/** Flatten pi's AgentToolResult into the plain text the UI expects. */
function toolOutputText(result: any): string {
  if (typeof result === 'string') return result;
  const blocks = result?.content;
  if (Array.isArray(blocks)) {
    const text = blocks.filter((c: any) => c?.type === 'text').map((c: any) => c.text).join('');
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
  private messageSeq = 0;
  private currentMessageId = '';
  private textIndex = new Map<string, number>();
  private toolIndex = new Map<string, { partId: string; name: string; input: unknown }>();
  private accum = new Map<string, string>();
  private partCount = 0;

  constructor(opts: AdapterOptions) {
    this.sessionID = opts.sessionID;
    this.mint = opts.mintMessageId;
  }

  private nextPart(): string {
    return partId(this.currentMessageId, this.partCount++);
  }

  translate(event: any): Wire[] {
    const sessionID = this.sessionID;
    switch (event.type) {
      case 'agent_start':
        return [{ type: 'session.status', properties: { sessionID, status: { type: 'running' } } }];

      case 'message_start': {
        // Only ASSISTANT messages translate. The worker publishes the USER
        // message itself at prompt time (pi's user message_start rendered an
        // empty duplicate bubble — dev session ae3a07fc), and pi's 'toolResult'
        // messages are already carried as tool PARTS on the assistant message
        // (dev session 7f218b0a rendered a stray toolResult row).
        if ((event.message?.role ?? 'assistant') !== 'assistant') return [];
        this.currentMessageId = this.mint ? this.mint() : `msg-${++this.messageSeq}`;
        this.partCount = 0;
        this.textIndex.clear();
        this.accum.clear();
        return [
          {
            type: 'message.updated',
            properties: {
              sessionID,
              info: {
                id: this.currentMessageId,
                role: event.message?.role ?? 'assistant',
                sessionID,
                time: { created: now() },
                modelID: event.message?.model,
                providerID: event.message?.provider,
              },
            },
          },
        ];
      }

      case 'message_update': {
        const inner = event.assistantMessageEvent;
        if (!inner) return [];
        // text ------------------------------------------------------------
        if (inner.type === 'text_start' || inner.type === 'text_delta' || inner.type === 'text_end') {
          const key = `text:${inner.contentIndex ?? 0}`;
          if (!this.textIndex.has(key)) this.textIndex.set(key, this.partCount++);
          const id = partId(this.currentMessageId, this.textIndex.get(key)!);
          const prev = this.accum.get(id) ?? '';
          const next = inner.type === 'text_delta' ? prev + (inner.delta ?? '') : (inner.text ?? prev);
          this.accum.set(id, next);
          return [
            {
              type: 'message.part.updated',
              properties: {
                sessionID,
                part: { id, messageID: this.currentMessageId, sessionID, type: 'text', text: next },
              },
            },
          ];
        }
        // thinking ---------------------------------------------------------
        if (inner.type === 'thinking_start' || inner.type === 'thinking_delta' || inner.type === 'thinking_end') {
          const key = `think:${inner.contentIndex ?? 0}`;
          if (!this.textIndex.has(key)) this.textIndex.set(key, this.partCount++);
          const id = partId(this.currentMessageId, this.textIndex.get(key)!);
          const prev = this.accum.get(id) ?? '';
          const next = inner.type === 'thinking_delta' ? prev + (inner.delta ?? '') : (inner.thinking ?? prev);
          this.accum.set(id, next);
          return [
            {
              type: 'message.part.updated',
              properties: {
                sessionID,
                part: { id, messageID: this.currentMessageId, sessionID, type: 'reasoning', text: next },
              },
            },
          ];
        }
        return [];
      }

      case 'tool_execution_start': {
        const id = this.nextPart();
        this.toolIndex.set(event.toolCallId, { partId: id, name: event.toolName, input: event.args });
        return [this.toolPart(id, event.toolName, { status: 'running', input: event.args, time: { start: now() } })];
      }

      case 'tool_execution_update': {
        const t = this.toolIndex.get(event.toolCallId);
        if (!t) return [];
        return [this.toolPart(t.partId, t.name, { status: 'running', input: t.input, time: { start: now() } })];
      }

      case 'tool_execution_end': {
        const t = this.toolIndex.get(event.toolCallId);
        if (!t) return [];
        // pi returns AgentToolResult { content: [{type:'text',text}], details }.
        // The UI's shell/file view-models read `state.output` as the command's
        // own output, so hand them the text — a JSON envelope would render as
        // a blob where stdout belongs.
        const output = toolOutputText(event.result);
        return [
          this.toolPart(
            t.partId,
            t.name,
            event.isError
              ? { status: 'error', input: t.input, error: output, time: { start: now(), end: now() } }
              : { status: 'completed', input: t.input, output, time: { start: now(), end: now() } },
          ),
        ];
      }

      case 'message_end': {
        if ((event.message?.role ?? 'assistant') !== 'assistant') return [];
        const stop = event.message?.stopReason;
        const out: Wire[] = [
          {
            type: 'message.updated',
            properties: {
              sessionID,
              info: {
                id: this.currentMessageId,
                role: event.message?.role ?? 'assistant',
                sessionID,
                time: { created: now(), completed: now() },
                tokens: event.message?.usage,
              },
            },
          },
        ];
        if (stop === 'error') {
          out.push({
            type: 'session.error',
            properties: { sessionID, error: { name: 'ProviderError', data: { message: event.message?.errorMessage } } },
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

  private toolPart(id: string, tool: string, state: Record<string, unknown>): Wire {
    return {
      type: 'message.part.updated',
      properties: {
        sessionID: this.sessionID,
        part: { id, messageID: this.currentMessageId, sessionID: this.sessionID, type: 'tool', tool, callID: id, state },
      },
    };
  }
}
