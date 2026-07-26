/**
 * The voice runtime — where a live call actually lives.
 *
 * A call is a LiveKit room plus a row in this in-process registry. The room
 * carries the actual audio (browser mic <-> Recall's rendered page <-> the
 * apps/voice-agent worker doing STT/LLM/TTS); this file never touches audio.
 * What it owns is the two hand-offs either side of that conversation:
 *
 *   worker ──POST /voice/prompt──► askKortix ──► continueSession   (send_prompt)
 *   Kortix turn ──► promptVoiceAgent ──► room data channel ──► worker  (say)
 *
 * The worker is a SEPARATE PROCESS (apps/voice-agent, not part of apps/api),
 * dispatched into the room by name and bootstrapped entirely from the room's
 * metadata — see `VoiceRoomMetadata` below and apps/voice-agent/README.md's
 * "The apps/api contract this app expects", which this file (plus routes.ts's
 * `/voice/{prompt,run-command,turns}` routes) implements.
 *
 * The single most important property, unchanged from the realtime-provider
 * version this replaces: `askKortix` (the old `ask_kortix`, now the worker's
 * `send_prompt` tool) answers in milliseconds and NEVER waits for the agent
 * turn. A Kortix turn runs 30s-10min; a conversation that blocks that long is
 * broken. Progress comes back later as unsolicited speech via
 * `promptVoiceAgent`, driven by the turn-relay (turn.ts).
 *
 * State is per-process and deliberately not in Postgres: a call is pinned to
 * whichever API instance handled its `voice_spawn`, and if that instance dies
 * the call is over anyway. Only the transcript is durable. This does mean the
 * worker's `/voice/*` POSTs must land on that same instance — true today for
 * the exact reason it was true of the old WebSocket bridge (a live call is
 * inherently sticky to one process); a shared registry (Redis, a DB lease) is
 * the fix if this ever needs to survive an instance restart, and is out of
 * scope here.
 */
import { and, asc, eq, gt } from 'drizzle-orm';
import { voiceCallTurns } from '@kortix/db';
import { continueSession } from '../../projects/session-lifecycle';
import { config } from '../../config';
import { db } from '../../shared/db';
import { createRoom, deleteRoom, KORTIX_REPLY_TOPIC, roomNameForCall, sendRoomData } from './livekit';
import { mintCallApiToken } from './worker-token';

/**
 * apps/voice-agent's TTS is hardcoded to `openai.TTS({ voice: 'alloy' })`
 * today (it does not yet read a voice choice from room metadata) — this list
 * exists for the MCP tool's UX (voice_spawn's `voice` enum) ahead of that
 * wiring, not because anything downstream currently honors it.
 */
const VOICES = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'] as const;
const DEFAULT_VOICE: (typeof VOICES)[number] = 'alloy';

export function availableVoices(): { voices: readonly string[]; default: string } {
  return { voices: VOICES, default: DEFAULT_VOICE };
}

export interface VoiceCall {
  callId: string;
  projectId: string;
  sessionId: string;
  botId: string | null;
  voice: string;
  /** LiveKit room name — `roomNameForCall(callId)`. */
  room: string;
  startedAt: number;
  closed: boolean;
}

const calls = new Map<string, VoiceCall>();

export function getCall(callId: string): VoiceCall | undefined {
  return calls.get(callId);
}

export function listCallsForSession(sessionId: string): VoiceCall[] {
  return [...calls.values()].filter((c) => c.sessionId === sessionId && !c.closed);
}

/**
 * Everything apps/voice-agent needs to bootstrap a freshly dispatched job,
 * carried in the LiveKit room's metadata so the worker never has to call back
 * into the API just to learn who it's talking to. Field names and shape are
 * fixed by that app's `call-context.ts` (`RoomMetadataShape`) — snake_case,
 * NOT this codebase's usual camelCase, because the contract is owned jointly
 * with a consumer this file cannot rename.
 */
export interface VoiceRoomMetadata {
  project_id: string;
  session_id: string;
  call_id: string;
  kortix_api_url: string;
  kortix_api_token: string;
  bot_name: string;
}

export interface StartCallInput {
  callId: string;
  projectId: string;
  sessionId: string;
  botId: string | null;
  botName: string;
  voice?: string | null;
}

export async function startCall(input: StartCallInput): Promise<VoiceCall> {
  const existing = calls.get(input.callId);
  if (existing && !existing.closed) return existing;

  const voice =
    input.voice && (VOICES as readonly string[]).includes(input.voice) ? input.voice : DEFAULT_VOICE;
  const room = roomNameForCall(input.callId);

  const metadata: VoiceRoomMetadata = {
    project_id: input.projectId,
    session_id: input.sessionId,
    call_id: input.callId,
    kortix_api_url: config.KORTIX_URL,
    kortix_api_token: mintCallApiToken(input.callId),
    bot_name: input.botName,
  };

  // Create the room, dispatched to the worker, BEFORE anything tries to join
  // it — same ordering the old code used for the provider connect: if the bot
  // arrives first it must find somewhere real to join.
  await createRoom(room, JSON.stringify(metadata));

  const call: VoiceCall = {
    callId: input.callId,
    projectId: input.projectId,
    sessionId: input.sessionId,
    botId: input.botId,
    voice,
    room,
    startedAt: Date.now(),
    closed: false,
  };
  calls.set(input.callId, call);
  return call;
}

function buildAskPrompt(request: string, callId: string): string {
  return [
    `[Live voice call ${callId}] Someone in the call asked: "${request}"`,
    '',
    'You are on a live call. Whatever you report back gets spoken aloud to the room,',
    'so answer in plain spoken language — no markdown, no bullet lists, no raw URLs.',
    'Keep it to a couple of sentences unless more was explicitly asked for.',
    '',
    'The conversation continues while you work; you are not holding the line.',
  ].join('\n');
}

/**
 * The mirror of the old `ask_kortix` tool-call handler, now driven by the
 * worker's `POST /voice/prompt` (routes.ts) instead of an in-process SDK
 * callback. Answers FIRST, then delivers — the caller (the HTTP route)
 * returns immediately after this resolves, well before `continueSession` has
 * done anything at all.
 */
export function askKortix(call: VoiceCall, request: string): { ok: true } | { ok: false; error: string } {
  const trimmed = request.trim();
  if (!trimmed) return { ok: false, error: 'empty request' };

  void continueSession({
    source: 'voice',
    sessionId: call.sessionId,
    text: buildAskPrompt(trimmed, call.callId),
    userId: null,
  })
    .then((outcome) => {
      if (outcome !== 'delivered') {
        console.error('[voice] ask_kortix not delivered', { outcome, sessionId: call.sessionId });
        // The conversation would otherwise hang on a promise nobody kept.
        promptVoiceAgent(
          call.callId,
          "I couldn't reach the agent session just now, so that request didn't go through.",
        );
      }
    })
    .catch((err) => console.error('[voice] ask_kortix delivery failed', err));

  return { ok: true };
}

export async function appendTurn(
  call: Pick<VoiceCall, 'callId' | 'projectId' | 'sessionId'>,
  role: 'user' | 'agent',
  text: string,
  speaker?: string | null,
): Promise<void> {
  const clean = text.trim();
  if (!clean) return;
  await db.insert(voiceCallTurns).values({
    callId: call.callId,
    projectId: call.projectId,
    sessionId: call.sessionId,
    role,
    speaker: speaker ?? null,
    text: clean,
  });
}

export interface TranscriptPage {
  turns: Array<{ cursor: number; role: string; speaker: string | null; text: string; at: string }>;
  cursor: number;
}

/**
 * Everything after `cursor`, in order. Returns immediately — empty when nothing
 * is new. This is the whole point: the agent checks in, it never listens.
 */
export async function readTurns(
  callId: string,
  cursor: number,
  limit = 200,
): Promise<TranscriptPage> {
  const rows = await db
    .select()
    .from(voiceCallTurns)
    .where(and(eq(voiceCallTurns.callId, callId), gt(voiceCallTurns.cursor, cursor)))
    .orderBy(asc(voiceCallTurns.cursor))
    .limit(limit);

  return {
    turns: rows.map((r) => ({
      cursor: r.cursor,
      role: r.role,
      speaker: r.speaker,
      text: r.text,
      at: r.createdAt.toISOString(),
    })),
    // Hold the caller's cursor when nothing arrived, so an idle poll is a no-op.
    cursor: rows.length > 0 ? rows[rows.length - 1]!.cursor : cursor,
  };
}

export async function endCall(callId: string): Promise<boolean> {
  const call = calls.get(callId);
  if (!call) return false;
  call.closed = true;
  calls.delete(callId);
  await deleteRoom(call.room);
  return true;
}

/**
 * Kortix prompting the voice agent — the mirror of `askKortix`. Rides the
 * LiveKit room data channel (RELIABLE) rather than a new HTTP callback: the
 * worker is already paying for that connection to do STT/TTS, so this needs
 * no new transport, and unlike an HTTP POST from here TO the worker, it
 * doesn't require knowing which machine the worker process is on. Topic and
 * payload shape are fixed by apps/voice-agent's `inbound-replies.ts` — see
 * `KORTIX_REPLY_TOPIC`'s doc comment. Always fire-and-forget — this function
 * must stay synchronous so callers (turn.ts) never block a turn on it.
 */
export function promptVoiceAgent(callId: string, text: string): boolean {
  const call = calls.get(callId);
  if (!call || call.closed) return false;
  void sendRoomData(call.room, KORTIX_REPLY_TOPIC, {
    type: 'kortix_reply',
    call_id: call.callId,
    text,
  }).catch((err) => console.error('[voice] say failed', err));
  return true;
}
