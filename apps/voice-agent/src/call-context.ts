/**
 * Where this worker learns WHICH call it is, and how to talk back to Kortix.
 *
 * A single worker process handles many jobs (rooms) concurrently, each one a
 * different project/session/call. So anything call-specific — project id,
 * session id, call id, and above all the per-call API credential — MUST come
 * from the job, not from a process-wide env var: an env var is shared by
 * every job this process ever runs, and a shared credential would let any
 * call impersonate any other project.
 *
 * Room metadata carries non-sensitive call context. Private dispatch metadata
 * carries the short-lived credential scoped to this call. Both values are
 * readable from `ctx.job` before `ctx.connect()` completes.
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
  bot_name?: unknown;
}

interface WorkerMetadataShape extends RoomMetadataShape {
  kortix_api_token?: unknown;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function parseMetadata<T extends object>(raw: string | undefined): T {
  if (!raw) return {} as T;
  try {
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object' ? parsed : {}) as T;
  } catch {
    return {} as T;
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
  roomMetadataRaw: string | undefined,
  workerMetadataRaw: string | undefined,
): CallContext {
  const roomMeta = parseMetadata<RoomMetadataShape>(roomMetadataRaw);
  const workerMeta = parseMetadata<WorkerMetadataShape>(workerMetadataRaw);

  const sessionId = asNonEmptyString(roomMeta.session_id) ?? asNonEmptyString(roomName);
  if (!sessionId) {
    throw new Error(
      'voice-agent: could not resolve a session id — room metadata had no session_id and the room has no name',
    );
  }

  const projectId = asNonEmptyString(roomMeta.project_id);
  if (!projectId) {
    throw new Error('voice-agent: room metadata is missing project_id');
  }

  const kortixApiToken = asNonEmptyString(workerMeta.kortix_api_token);
  if (!kortixApiToken) {
    throw new Error('voice-agent: worker metadata is missing kortix_api_token');
  }

  return {
    projectId,
    sessionId,
    callId: asNonEmptyString(roomMeta.call_id) ?? sessionId,
    kortixApiUrl:
      asNonEmptyString(roomMeta.kortix_api_url) ??
      process.env.KORTIX_API_URL ??
      'http://localhost:8008',
    kortixApiToken,
    botName: asNonEmptyString(roomMeta.bot_name) ?? 'Kortix',
  };
}
