import { sessionSandboxes } from '@kortix/db';
import { and, desc, eq } from 'drizzle-orm';

import { db } from '../../shared/db';
import {
  ensureOpencodeSessionPin,
  sandboxOpencodeEndpoint,
} from '../opencode-mapping';
import { sandboxRuntimeRequestHeaders } from '../sandbox-fetch';
import type { ProjectSessionRow } from './serializers';
import {
  type CompactMessage,
  type CompactToolCall,
  compactMessage,
  normalizeMessageList,
} from './session-transcript-compact';
import {
  type MirrorMessage,
  type MirrorSnapshot,
  readSessionTranscriptMirror,
} from './session-transcript-mirror';

const WORKSPACE_DIRECTORY = '/workspace';

export type { CompactMessage, CompactToolCall };

/**
 * Which source answered.
 *
 * A NEGATIVE IS A CLAIM, so this is never inferred from an empty array. `live`
 * is the sandbox's own OpenCode endpoint; `mirror` is the durable server-side
 * copy written at turn end (`session-transcript-mirror.ts`); `none` is the
 * honest "nothing could answer", and it is the only value that ever accompanies
 * `available: false`. Mirror and live are NEVER merged — the field says which
 * one you got.
 */
export type SessionTranscriptSource = 'live' | 'mirror' | 'none';

export interface SessionTranscriptDigest {
  available: boolean;
  /** Why this is not a live read. Set on `mirror` too, where it carries the
   *  reason the live path could not answer — an unavailable digest is not the
   *  only thing worth explaining. */
  reason: string | null;
  source: SessionTranscriptSource;
  /**
   * The response contains the session's FIRST message — nothing older exists in
   * the source that answered. For `live` that means the box returned fewer
   * messages than the window asked for; for `mirror` it is the `head_complete`
   * bit a capture PROVED (and retention pruning clears). False means "this is a
   * tail", never "something is broken".
   */
  complete: boolean;
  /** When the mirror was last written. Null for a live read. */
  captured_at: string | null;
  opencode_session_id: string | null;
  message_count: number;
  messages: CompactMessage[];
}

/** The sync-store shape: OpenCode message envelopes verbatim, with the parts
 *  array stripped of tool inputs/outputs and file urls. Mirror-only — a running
 *  session's client reads the runtime directly. */
export interface SessionTranscriptSyncEnvelope {
  available: boolean;
  reason: string | null;
  source: SessionTranscriptSource;
  complete: boolean;
  captured_at: string | null;
  opencode_session_id: string | null;
  message_count: number;
  messages: MirrorMessage[];
}

/** Seam for tests: the mirror read is the one collaborator whose absence vs
 *  presence changes which branch the digest takes, and a DB is not needed to
 *  prove that. Production never passes it. */
export interface SessionTranscriptDeps {
  readMirror?: (sessionId: string, limit: number) => Promise<MirrorSnapshot | null>;
}

export async function buildSessionTranscriptDigest(
  input: {
    session: ProjectSessionRow;
    projectId: string;
    accountId: string;
    userId: string;
    limit: number;
    maxChars: number;
  },
  deps: SessionTranscriptDeps = {},
): Promise<SessionTranscriptDigest> {
  const { session, projectId, accountId, userId, limit, maxChars } = input;
  const readMirror = deps.readMirror ?? readMirrorSafely;

  /**
   * The live path could not answer. Serve the durable mirror if there is one —
   * a stopped session is the WHOLE reason the mirror exists — and say so in
   * `source`. Falling back to `unavailable` when a mirror exists would be the
   * old behaviour with extra steps.
   */
  const degrade = async (
    reason: string,
    opencodeSessionId: string | null,
  ): Promise<SessionTranscriptDigest> => {
    const mirror = await readMirror(session.sessionId, limit);
    if (mirror) {
      return {
        available: true,
        reason,
        source: 'mirror',
        complete: mirrorIsComplete(mirror),
        captured_at: mirror.captured_at,
        opencode_session_id: mirror.opencode_session_id ?? opencodeSessionId,
        message_count: mirror.messages.length,
        messages: mirror.messages.map((m) =>
          compactMessage({ info: m.info as never, parts: m.parts as never }, maxChars),
        ),
      };
    }
    return {
      available: false,
      reason,
      source: 'none',
      complete: false,
      captured_at: null,
      opencode_session_id: opencodeSessionId,
      message_count: 0,
      messages: [],
    };
  };

  if (session.status !== 'running') {
    return degrade(
      `session is ${session.status}; live transcript requires a running sandbox`,
      session.opencodeSessionId,
    );
  }

  const externalId = await resolveSessionExternalId({ session, projectId, accountId });
  if (!externalId) {
    return degrade('session has no reachable sandbox external id yet', session.opencodeSessionId);
  }

  const ensured = await ensureOpencodeSessionPin({
    projectId,
    sessionId: session.sessionId,
    accountId,
    externalId,
    userId,
    currentPin: session.opencodeSessionId,
  });
  const opencodeSessionId = ensured.pin;
  if (!opencodeSessionId) {
    return degrade(opencodeReason(ensured.reason), null);
  }

  // Endpoint resolution touches the sandbox provider (Daytona preview-link /
  // service-key lookup) and can throw on a 429 `ThrottlerException` rate limit,
  // an archived/deleted box, or a transient provider outage. This digest is
  // best-effort enrichment (the session row is already loaded); a provider
  // throw must NEVER bubble up and 500 the transcript read (see #3567 for the
  // sibling title-sync fix — this is the same class of bug on a different
  // post-#3567 call site). Degrade to the mirror instead.
  let endpoint: { url: string; headers: Record<string, string> } | null;
  try {
    endpoint = await sandboxOpencodeEndpoint(externalId, userId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return degrade(`could not reach sandbox: ${message}`, opencodeSessionId);
  }
  if (!endpoint) {
    return degrade('sandbox service key unavailable', opencodeSessionId);
  }

  try {
    const url = new URL(
      `${endpoint.url}/session/${encodeURIComponent(opencodeSessionId)}/message`,
    );
    url.searchParams.set('directory', WORKSPACE_DIRECTORY);
    url.searchParams.set('limit', String(limit));
    const res = await fetch(url, {
      method: 'GET',
      headers: sandboxRuntimeRequestHeaders(endpoint.headers),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) {
      return degrade(await messageReadReason(res), opencodeSessionId);
    }
    const payload = (await res.json().catch(() => null)) as unknown;
    const rawMessages = normalizeMessageList(payload).slice(-limit);
    return {
      available: true,
      reason: null,
      source: 'live',
      // Fewer than the window asked for means the box had nothing older.
      complete: rawMessages.length < limit,
      captured_at: null,
      opencode_session_id: opencodeSessionId,
      message_count: rawMessages.length,
      messages: rawMessages.map((m) => compactMessage(m, maxChars)),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return degrade(`could not read sandbox transcript: ${message}`, opencodeSessionId);
  }
}

/**
 * The sync-store envelope. Always the mirror: a client whose sandbox is up
 * reads the runtime directly, so re-proxying it here would only duplicate the
 * body this endpoint exists to avoid.
 */
export async function buildSessionTranscriptSyncEnvelope(
  input: {
    session: ProjectSessionRow;
    limit: number;
  },
  deps: SessionTranscriptDeps = {},
): Promise<SessionTranscriptSyncEnvelope> {
  const mirror = await (deps.readMirror ?? readMirrorSafely)(
    input.session.sessionId,
    input.limit,
  );
  if (!mirror) {
    return {
      available: false,
      reason: 'no server-side transcript has been captured for this session yet',
      source: 'none',
      complete: false,
      captured_at: null,
      opencode_session_id: input.session.opencodeSessionId,
      message_count: 0,
      messages: [],
    };
  }
  return {
    available: true,
    reason: null,
    source: 'mirror',
    complete: mirrorIsComplete(mirror),
    captured_at: mirror.captured_at,
    opencode_session_id: mirror.opencode_session_id ?? input.session.opencodeSessionId,
    message_count: mirror.messages.length,
    messages: mirror.messages,
  };
}

/** Complete only when the mirror proved it holds the head AND this window
 *  returned every row it holds. Both halves are evidence, neither is a guess. */
export function mirrorIsComplete(mirror: MirrorSnapshot): boolean {
  return mirror.head_complete && mirror.messages.length >= mirror.total;
}

/** A mirror read must never be able to fail a transcript request: the mirror is
 *  an enrichment, and its absence is already an expressible answer. */
async function readMirrorSafely(sessionId: string, limit: number): Promise<MirrorSnapshot | null> {
  try {
    return await readSessionTranscriptMirror({ sessionId, limit });
  } catch (err) {
    console.warn(
      `[transcript-mirror] read failed for session ${sessionId}:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

async function resolveSessionExternalId(input: {
  session: ProjectSessionRow;
  projectId: string;
  accountId: string;
}): Promise<string | null> {
  const fromUrl = externalIdFromSandboxUrl(input.session.sandboxUrl);
  if (fromUrl) return fromUrl;

  const [row] = await db
    .select({ externalId: sessionSandboxes.externalId })
    .from(sessionSandboxes)
    .where(
      and(
        eq(sessionSandboxes.sessionId, input.session.sessionId),
        eq(sessionSandboxes.projectId, input.projectId),
        eq(sessionSandboxes.accountId, input.accountId),
      ),
    )
    .orderBy(desc(sessionSandboxes.updatedAt))
    .limit(1);
  return row?.externalId ?? null;
}

function externalIdFromSandboxUrl(url: string | null): string | null {
  if (!url) return null;
  const match = url.match(/\/p\/([^/]+)\//);
  return match?.[1] ?? null;
}

function opencodeReason(reason: string): string {
  switch (reason) {
    case 'not_ready':
      return 'OpenCode session not ready in the sandbox';
    case 'unreachable':
      return 'OpenCode session list unreachable in the sandbox';
    case 'healed':
    case 'unchanged':
      return 'no OpenCode session id found in the sandbox';
    default:
      return `OpenCode session unavailable: ${reason}`;
  }
}

async function messageReadReason(res: Response): Promise<string> {
  let payload: unknown = null;
  try {
    payload = await res.json();
  } catch {
    // Ignore non-JSON bodies from upstreams.
  }
  const detail =
    typeof payload === 'object' && payload && 'error' in payload && typeof (payload as { error?: unknown }).error === 'string'
      ? (payload as { error: string }).error
      : typeof payload === 'object' && payload && 'message' in payload && typeof (payload as { message?: unknown }).message === 'string'
        ? (payload as { message: string }).message
        : null;
  if (res.status === 503) return detail ?? 'OpenCode not ready in the sandbox';
  if (res.status === 404) return detail ?? 'OpenCode session messages not found';
  return detail ? `OpenCode messages unavailable: ${detail}` : `OpenCode messages unavailable: HTTP ${res.status}`;
}
