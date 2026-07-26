/**
 * LiveKit wiring for the voice channel — the ONLY module that touches
 * LiveKit's control plane (room admin, access tokens, the room data channel).
 * Everything above this (runtime.ts, mcp.ts, voice-join.ts) deals in call ids
 * and room names, never in raw LiveKit credentials, for the same reason
 * provider.ts drew a hard line around the old realtime WebSocket: a
 * compromised caller must never get to mint its own room access.
 *
 * `AccessToken.toJwt()` and `RoomServiceClient` are the two API surfaces
 * everything below is built on — see the LiveKit API reference this file was
 * written against for the exact gotchas (toJwt() is async in 2.x;
 * RoomServiceClient wants an http(s) host, not the ws(s) LIVEKIT_URL).
 */
import { AccessToken, DataPacket_Kind, RoomServiceClient } from 'livekit-server-sdk';
import { config } from '../../config';

/**
 * One room per call, named deterministically from the call id. `callId` is
 * already the source of truth (it IS the session id — see runtime.ts), so
 * there is no separate room<->call mapping to keep in sync or leak.
 */
export function roomNameForCall(callId: string): string {
  return `voice-${callId}`;
}

let _roomService: RoomServiceClient | null = null;
function roomService(): RoomServiceClient {
  if (_roomService) return _roomService;
  // RoomServiceClient's `host` must be http(s); LIVEKIT_URL is ws(s) (it's
  // also what agents-js workers dial with). Swap the scheme rather than
  // asking operators to configure the same server twice.
  const httpUrl = config.LIVEKIT_URL.replace(/^ws/i, 'http');
  _roomService = new RoomServiceClient(httpUrl, config.LIVEKIT_API_KEY, config.LIVEKIT_API_SECRET);
  return _roomService;
}

/** Comfortably past a real meeting's length — the call ending is what really ends it. */
const DEFAULT_TOKEN_TTL_SECONDS = 6 * 60 * 60;

export interface MintAccessTokenInput {
  room: string;
  identity: string;
  name?: string;
  canPublish?: boolean;
  canSubscribe?: boolean;
  ttlSeconds?: number;
}

export async function mintAccessToken(input: MintAccessTokenInput): Promise<string> {
  const at = new AccessToken(config.LIVEKIT_API_KEY, config.LIVEKIT_API_SECRET, {
    identity: input.identity,
    name: input.name,
    ttl: input.ttlSeconds ?? DEFAULT_TOKEN_TTL_SECONDS,
  });
  at.addGrant({
    room: input.room,
    roomJoin: true,
    canPublish: input.canPublish ?? true,
    canSubscribe: input.canSubscribe ?? true,
  });
  return at.toJwt();
}

/**
 * Create the room before anything tries to join it. Deliberately NO explicit
 * `agents: [{ agentName }]` dispatch: apps/voice-agent (the actual deployed
 * worker — see its README) registers itself with `ServerOptions({ agent })`
 * and does not set `LIVEKIT_AGENT_NAME`, so it runs UNNAMED and only receives
 * LiveKit's default AUTOMATIC dispatch. An explicit named dispatch entry here
 * would opt this room OUT of automatic dispatch and the unnamed worker would
 * never be sent to it — the room would sit empty. If a named worker is ever
 * introduced, add `agents` back here with the matching name at the same time.
 * `metadata` carries everything a freshly dispatched worker needs to
 * bootstrap itself — see runtime.ts's `VoiceRoomMetadata` — so it never has
 * to call back into the API just to learn who it's talking to.
 */
export async function createRoom(room: string, metadata: string): Promise<void> {
  const svc = roomService();

  // Delete any existing room of this name FIRST. LiveKit's automatic agent
  // dispatch fires on room CREATION, and createRoom() is a no-op on a room that
  // already exists — so re-spawning a call for a session whose room is still
  // alive (departureTimeout keeps it for 15min) silently produces a room with
  // NO agent in it. That was the intermittent "worker registered but never got
  // a job" failure: it only ever worked when the previous room happened to have
  // expired first. Deleting is safe — a room worth keeping has a live call in
  // it, and that call owns this same name.
  await svc.deleteRoom(room).catch(() => {
    // Room did not exist; that is the normal path.
  });

  await svc.createRoom({
    name: room,
    metadata,
    // emptyTimeout covers "created but nobody ever joined". departureTimeout is
    // the one that actually bites: it governs how long the room survives after
    // the LAST participant leaves, and its default (~20s) is short enough that a
    // brief gap — a page reload, a bot reconnect — destroys the room. A
    // participant rejoining then IMPLICITLY recreates it with NO metadata, and
    // the agent worker dies with "room metadata is missing project_id" because
    // the call context and its API token travel in that metadata.
    emptyTimeout: 30 * 60,
    departureTimeout: 15 * 60,
    maxParticipants: 8,
  });

  // NOTE: an explicit updateRoomMetadata() call was tried here to cover the
  // case where a room already exists (createRoom no-ops, so its metadata would
  // stay empty). It failed on every call AND correlated exactly with agent jobs
  // no longer being dispatched, so it is deliberately not done. departureTimeout
  // above is the real fix for the vanishing-room problem it was meant to patch.
  // If the pre-existing-room case ever bites, delete the room first rather than
  // trying to mutate it.
}

/** Best-effort — an empty room times out on its own via `emptyTimeout` anyway. */
export async function deleteRoom(room: string): Promise<void> {
  await roomService()
    .deleteRoom(room)
    .catch((err) => console.error('[voice/livekit] deleteRoom failed', err));
}

/**
 * The page Recall renders inside the bot, now a plain LiveKit client instead
 * of a raw-audio-WebSocket page. URL shape is fixed by that page
 * (apps/web/src/app/(public)/voice/[token]/page.tsx, out of scope to edit
 * here): the LAST PATH SEGMENT is the raw LiveKit access token itself — not a
 * room name; the token's own grant already encodes which room it joins — and
 * the LiveKit server URL rides in the `url` query param, since the page can't
 * guess LIVEKIT_URL from window.location (Recall's browser runs on infra with
 * no relationship to either the API's or the frontend's own origin).
 */
export function bridgePageUrl(frontendUrl: string, token: string): string {
  const qs = new URLSearchParams({ url: config.LIVEKIT_URL });
  return `${frontendUrl.replace(/\/+$/, '')}/voice/${encodeURIComponent(token)}?${qs.toString()}`;
}

/**
 * Topic apps/voice-agent's `inbound-replies.ts` listens on for Kortix ->
 * call messages. Wire format is fixed by that app (not renegotiable from this
 * side without editing it, which is out of scope here): payload must be
 * `{ type: 'kortix_reply', call_id, text }`. See `promptVoiceAgent` in
 * runtime.ts, the only caller.
 */
export const KORTIX_REPLY_TOPIC = 'kortix';

/**
 * Publish a data message into a room via the server API (no participant
 * identity required — this is LiveKit's control plane speaking, not a room
 * member). RELIABLE delivery so a message sent while the worker briefly drops
 * isn't silently lost. Callers must NOT await this on any path that has to
 * return in milliseconds — it's a real network call to LiveKit.
 */
export async function sendRoomData(room: string, topic: string, payload: unknown): Promise<void> {
  const data = new TextEncoder().encode(JSON.stringify(payload));
  await roomService().sendData(room, data, DataPacket_Kind.RELIABLE, { topic });
}
