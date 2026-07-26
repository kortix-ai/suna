/**
 * Posts each finalized turn of the conversation back to Kortix, mirroring
 * what the old in-process `appendTurn()` wrote to `voice_call_turns`.
 *
 * The user side and the agent side use TWO DIFFERENT mechanisms on purpose —
 * they are not symmetric, and treating them as if they were is exactly what
 * produced the one-sided-transcript bug this file used to have.
 *
 * USER SIDE: `Agent.onUserTurnCompleted(chatCtx, newMessage)`
 * (`voice/agent.ts:316`), called from `AgentActivity.userTurnCompleted()`
 * (`voice/agent_activity.ts:2376`) — unconditionally, once per real completed
 * user turn, BEFORE the message is scheduled/committed to chat context. This
 * is invoked directly by index.ts (it is a documented per-Agent override
 * point, not an event you subscribe to) which then calls `postUserTurn` here.
 *
 * AGENT SIDE: `AgentSessionEventTypes.ConversationItemAdded`, filtered to
 * `role === 'assistant'`. This is the one part of the OLD approach that was
 * actually correct and proven — verified against @livekit/agents@1.5.5
 * source (`voice/agent_activity.ts:2639-2646`, the TTS-side insert) and
 * confirmed empirically across every test run: this event fires 1:1 with
 * every real spoken agent reply, no misses, no dupes.
 *
 * What this file explicitly does NOT do any more, and why:
 *  - `ConversationItemAdded` for role==='user': per source
 *    (`agent_activity.ts:2857-2862`), the user-role insert into
 *    `session.history` and the event emission happen in the SAME atomic call
 *    (`AgentSession._conversationItemAdded`, `agent_session.ts:1462-1465`).
 *    Instrumented live across a full conversation, it delivered only
 *    `role:'assistant'` items (plus one `agent_handoff`) — never `role:'user'`.
 *    Whatever gates that atomic call for the user side in practice (most
 *    likely `speechHandle.scheduled` racing something in this pipeline
 *    config) means this event is not a reliable signal for the user's turn,
 *    even though the source says it fires alongside the history insert.
 *  - Draining `session.history` on that event: built on the premise that
 *    history might contain user items the event missed — but they are
 *    populated by the exact same atomic call, so there is nothing there that
 *    the event wouldn't have already reported. Not an independent safety net.
 *  - `UserInputTranscribed`: never fires, under either the OpenAI STT plugin
 *    or LiveKit Inference deepgram/flux-general-en. Confirmed dead in this
 *    SDK version for this config.
 */
import { voice } from '@livekit/agents';
import type { ChatContext, ChatMessage } from '@livekit/agents';
import type { CallContext } from './call-context';
import { postTranscriptTurn } from './kortix-client';

function extractText(content: readonly unknown[]): string {
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object') {
        const t = (part as { text?: unknown }).text;
        if (typeof t === 'string') return t;
      }
      return '';
    })
    .join('')
    .trim();
}

/**
 * Called directly from index.ts's `agent.onUserTurnCompleted` override, once
 * per real completed user turn, with the SDK's own committed transcript for
 * that turn. `rawTextContent` (not `textContent`) because `textContent`
 * strips LiveKit's `<expr/>` markup for `role === 'assistant'` only — for a
 * `role === 'user'` message they're identical, but `rawTextContent` is the
 * one that's correct for both, so it's the one to standardize on here.
 */
export function postUserTurn(ctx: CallContext, _chatCtx: ChatContext, newMessage: ChatMessage): void {
  const text = (newMessage.rawTextContent ?? '').trim();
  if (!text) return;
  void postTranscriptTurn(ctx, 'user', text);
}

export function wireTranscripts(session: voice.AgentSession<CallContext>, ctx: CallContext): void {
  const postedAgentItems = new Set<string>();

  session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (ev) => {
    const item = ev.item;
    if (item.type !== 'message') return; // skip agent-handoff items
    if (item.role !== 'assistant') return; // the user side is captured via onUserTurnCompleted, not this event

    const id = (item as { id?: string }).id ?? '';
    if (id) {
      if (postedAgentItems.has(id)) return;
      postedAgentItems.add(id);
    }

    console.log('[voice-debug] ConversationItemAdded', { role: 'agent', itemId: id });

    const text = extractText(item.content);
    if (!text) return;

    // Fire-and-forget: a transcript write must never delay or interrupt the
    // live conversation (see kortix-client.ts's postTranscriptTurn doc).
    void postTranscriptTurn(ctx, 'agent', text);
  });
}
