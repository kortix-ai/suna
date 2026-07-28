/**
 * LiveKit wiring for the voice channel — the ONLY module that touches
 * LiveKit's control plane (room admin, access tokens, the room data channel).
 * Everything above this (runtime.ts, mcp.ts, routes.ts) deals in call ids
 * and room names, never in raw LiveKit credentials, for the same reason
 * provider.ts drew a hard line around the old realtime WebSocket: a
 * compromised caller must never get to mint its own room access.
 *
 * `AccessToken.toJwt()` and `RoomServiceClient` are the two API surfaces
 * everything below is built on — see the LiveKit API reference this file was
 * written against for the exact gotchas (toJwt() is async in 2.x;
 * RoomServiceClient wants an http(s) host, not the ws(s) LIVEKIT_URL).
 */
import {
  AccessToken,
  AgentDispatchClient,
  DataPacket_Kind,
  RoomServiceClient,
} from 'livekit-server-sdk';
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
 * The worker's registered name — must match `VOICE_AGENT_NAME` in
 * apps/voice-agent/src/index.ts. A mismatch means every dispatch below targets
 * a worker that does not exist, and calls start with nobody on the other end.
 */
export const VOICE_AGENT_NAME = 'kortix-voice';

let _dispatchClient: AgentDispatchClient | null = null;
function dispatchClient(): AgentDispatchClient {
  if (!_dispatchClient) {
    _dispatchClient = new AgentDispatchClient(
      config.LIVEKIT_URL.replace(/^ws/i, 'http'),
      config.LIVEKIT_API_KEY,
      config.LIVEKIT_API_SECRET,
    );
  }
  return _dispatchClient;
}

/**
 * Create the room, then EXPLICITLY dispatch the voice worker into it.
 *
 * The explicit dispatch is the whole point. LiveKit's automatic dispatch fires
 * only on room CREATION and gives no signal when it doesn't happen: a room that
 * already exists makes `createRoom` a no-op, a participant rejoining after
 * `departureTimeout` recreates the room implicitly with no job and no metadata,
 * and both failures look identical from here — a registered worker that just
 * never gets work, discovered only when someone opens the link and talks to an
 * empty room. `createDispatch` replaces that silence with a call that either
 * returns a dispatch id or throws, so `startCall` fails at spawn time rather
 * than handing out a dead link.
 *
 * `roomMetadata` is visible to room participants and must stay non-sensitive.
 * `dispatchMetadata` is private worker bootstrap state and may carry the
 * per-call API bearer.
 */
export async function createRoom(
  room: string,
  roomMetadata: string,
  dispatchMetadata: string,
): Promise<void> {
  const svc = roomService();

  // Delete any existing room of this name first so the call starts from a clean
  // slate — stale metadata on a surviving room outlives the call that wrote it,
  // and `createRoom` will not overwrite it (updateRoomMetadata is deliberately
  // not used here; see the note below). Safe: a room worth keeping has a live
  // call in it, and that call owns this same name.
  await svc.deleteRoom(room).catch(() => {
    // Room did not exist; that is the normal path.
  });

  await svc.createRoom({
    name: room,
    metadata: roomMetadata,
    // emptyTimeout covers "created but nobody ever joined". departureTimeout is
    // the one that actually bites: it governs how long the room survives after
    // the LAST participant leaves, and its default (~20s) is short enough that a
    // brief gap — a page reload, a bot reconnect — destroys the room. A
    // participant rejoining then IMPLICITLY recreates it with NO metadata, and
    // the agent worker dies with "room metadata is missing project_id" because
    // the non-secret call context still travels in that metadata.
    emptyTimeout: 30 * 60,
    departureTimeout: 15 * 60,
    maxParticipants: 8,
  });

  // NOTE: an explicit updateRoomMetadata() call was tried here to cover the
  // case where a room already exists (createRoom no-ops, so its metadata would
  // stay empty). It failed on every call, so it is deliberately not done — the
  // deleteRoom above is the fix for the pre-existing-room case instead.

  // Deliberately NOT caught. A call whose agent could not be dispatched is a
  // dead call, and the caller needs to learn that here — while it can still
  // report a failure — rather than by handing someone a link to an empty room.
  await dispatchClient().createDispatch(room, VOICE_AGENT_NAME, { metadata: dispatchMetadata });
}

/**
 * Whether a dispatched voice worker is actually present in the room.
 *
 * The worker joins under an `agent-*` identity (LiveKit assigns it from the job
 * id), which is the only thing distinguishing it from the humans on the call.
 * Used to answer "is there anyone to hear this?" before claiming a prompt was
 * delivered — see runtime.ts's `promptVoiceAgentChecked`.
 */
export async function roomHasAgent(room: string): Promise<boolean> {
  const participants = await roomService()
    .listParticipants(room)
    .catch(() => [] as Awaited<ReturnType<RoomServiceClient['listParticipants']>>);
  return participants.some((p) => p.identity.startsWith('agent-'));
}

/**
 * The `kortix_api_url` a live room's metadata was created with, or null if the
 * room is gone / has no usable metadata.
 *
 * Used to decide whether an existing room is still reusable: the worker
 * bootstraps entirely from this metadata, so a room pointing at an API that no
 * longer answers produces an agent that talks but cannot act.
 */
export async function roomCallbackUrl(room: string): Promise<string | null> {
  const [existing] = await roomService()
    .listRooms([room])
    .catch(() => [] as Awaited<ReturnType<RoomServiceClient['listRooms']>>);
  if (!existing?.metadata) return null;
  try {
    const parsed = JSON.parse(existing.metadata) as { kortix_api_url?: unknown };
    return typeof parsed.kortix_api_url === 'string' ? parsed.kortix_api_url : null;
  } catch {
    return null;
  }
}

/** Best-effort — an empty room times out on its own via `emptyTimeout` anyway. */
export async function deleteRoom(room: string): Promise<void> {
  await roomService()
    .deleteRoom(room)
    .catch((err) => console.error('[voice/livekit] deleteRoom failed', err));
}

/**
 * The join link a human opens directly in their own browser — a plain
 * LiveKit client page (apps/web/src/app/(public)/voice/[token]/page.tsx, out
 * of scope to edit here beyond what its own file documents). The LAST PATH
 * SEGMENT is a short, ungessable, server-resolved token (see join-links.ts's
 * `mintJoinLink`) — NOT a LiveKit access token and NOT a room name. The page
 * exchanges it for a freshly-minted LiveKit token + server URL via
 * `GET /v1/public/voice-join/:token` (public-join-routes.ts) rather than
 * having either one handed to it directly in the URL.
 *
 * This used to embed the raw ~300-character signed LiveKit JWT itself (plus
 * the server URL in a `?url=` query param). That link was fragile by
 * construction: one character corrupted in transit between minting and the
 * browser (chat/speech/UI all get to mangle a URL this long) breaks the JWT
 * signature, and the failure mode is an opaque "could not establish signal
 * connection: invalid token" with nothing to retry. A short id can't corrupt
 * the same way, and resolving it server-side means a fresh, short-TTL
 * credential is minted at OPEN time rather than at spawn time.
 */
export function joinPageUrl(frontendUrl: string, joinToken: string): string {
  return `${frontendUrl.replace(/\/+$/, '')}/voice/${encodeURIComponent(joinToken)}`;
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
