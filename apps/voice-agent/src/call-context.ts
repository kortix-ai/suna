/**
 * Where this worker learns WHICH call it is, and how to talk back to Kortix.
 *
 * A single worker process handles many jobs (rooms) concurrently, each one a
 * different project/session/call. So anything call-specific — project id,
 * session id, call id, and above all the per-call API credential — MUST come
 * from the room, not from a process-wide env var: an env var is shared by
 * every job this process ever runs, and a shared credential would let any
 * call impersonate any other project.
 *
 * The room's metadata is the vehicle: apps/api mints a short-lived credential
 * scoped to this one call and sets it as JSON room metadata when it creates
 * the LiveKit room (`RoomServiceClient.createRoom({ name, metadata })`, see
 * livekit-server-sdk's `CreateOptions.metadata`), before dispatching this
 * agent into it. `ctx.job.room.metadata` carries that JSON straight through —
 * it is a snapshot of the room's server-side state at dispatch time, so it is
 * readable immediately in the entrypoint, before `ctx.connect()` completes.
 *
 * Only things that really are the same for every job on this process — how to
 * reach LiveKit itself, and a fallback Kortix API base URL for local dev —
 * come from env vars, and even those are just fallbacks: room metadata always
 * wins when present. See README.md for the full list.
 */

export interface CallContext {
  /** The Kortix project this call belongs to. */
  projectId: string;
  /** The Kortix session this call is bound to. Also the LiveKit room name. */
  sessionId: string;
  /**
   * Identifies this call for transcript writes and inbound replies. One live
   * call per session today (mirrors apps/api/src/channels/voice/routes.ts:
   * "The call id IS the session id"), so this defaults to `sessionId` when
   * room metadata does not set it explicitly.
   */
  callId: string;
  /** Kortix API base URL, e.g. `https://api.kortix.com` or `http://localhost:8008`. */
  kortixApiUrl: string;
  /** Short-lived, call-scoped bearer credential. Never a shared/static token. */
  kortixApiToken: string;
  /** Spoken display name for the agent's own persona ("You are <botName>..."). */
  botName: string;
}

interface RoomMetadataShape {
  project_id?: unknown;
  session_id?: unknown;
  call_id?: unknown;
  kortix_api_url?: unknown;
  kortix_api_token?: unknown;
  bot_name?: unknown;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function parseMetadata(raw: string | undefined): RoomMetadataShape {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as RoomMetadataShape) : {};
  } catch {
    // Malformed metadata is treated as absent, not fatal — the caller decides
    // whether the fields it needed were actually required.
    return {};
  }
}

/**
 * Builds this job's `CallContext` from the LiveKit room it was dispatched
 * into. Throws with a message naming exactly what was missing — this runs
 * once at the top of the entrypoint, so failing loudly and immediately beats
 * limping into a call the worker cannot actually talk to Kortix from.
 */
export function resolveCallContext(
  roomName: string | undefined,
  metadataRaw: string | undefined,
): CallContext {
  const meta = parseMetadata(metadataRaw);

  const sessionId = asNonEmptyString(meta.session_id) ?? asNonEmptyString(roomName);
  if (!sessionId) {
    throw new Error(
      'voice-agent: could not resolve a session id — room metadata had no session_id and the room has no name',
    );
  }

  const projectId = asNonEmptyString(meta.project_id);
  if (!projectId) {
    throw new Error('voice-agent: room metadata is missing project_id');
  }

  const kortixApiToken = asNonEmptyString(meta.kortix_api_token);
  if (!kortixApiToken) {
    throw new Error('voice-agent: room metadata is missing kortix_api_token');
  }

  return {
    projectId,
    sessionId,
    callId: asNonEmptyString(meta.call_id) ?? sessionId,
    kortixApiUrl:
      asNonEmptyString(meta.kortix_api_url) ??
      process.env.KORTIX_API_URL ??
      'http://localhost:8008',
    kortixApiToken,
    botName: asNonEmptyString(meta.bot_name) ?? 'Kortix',
  };
}
