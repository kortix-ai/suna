import { sessionSandboxes } from '@kortix/db';
import { and, desc, eq } from 'drizzle-orm';

import type {
  SessionTranscript as SessionTranscriptDigest,
  SessionTranscriptSyncEnvelope,
} from '@kortix/api-contract';
import { db } from '../../lib/db';
import { withTimeout } from '../../lib/with-timeout';
import { logger as appLogger } from '../../lib/logger';
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
  boundMirrorWindow,
  MIRROR_WINDOW_MAX_CHARS,
  type MirrorMessage,
  type MirrorSnapshot,
  readSessionTranscriptMirror,
  UnknownTranscriptCursorError,
} from './session-transcript-mirror';

const WORKSPACE_DIRECTORY = '/workspace';

/**
 * Budget for resolving the sandbox's daemon endpoint inside a transcript
 * read. The request deadline is 25 s and the rest of the live attempt is
 * already bounded (3 s session list, 8 s message fetch), so 8 s keeps the
 * worst attempt under the deadline. Unbounded, Daytona's preview-link
 * resolution runs two provider calls of up to 20 s each — 2026-09-29: a
 * cold/wedged provider stacked that into 25 s deadline 503s and 20–25 s
 * reads on GET /v1/projects/:id/sessions/:id/transcript.
 * # ponytail: 8 s ceiling converts a slow-but-live read into a possibly-stale
 * mirror answer; raise it if callers ever need longer live waits.
 */
const TRANSCRIPT_ENDPOINT_BUDGET_MS = 8_000;

/**
 * A degraded live attempt is expected backpressure — a wedged box during a
 * burst degrades every read it is asked for. One line per degrade was the
 * 2026-09-28 `[audit] Write contended` spike class (KRTX-614, learnings:
 * "Rate-limit the warning for expected backpressure"): report the FIRST
 * occurrence, then at most one line per interval. Every degrade still
 * degrades; the per-request `reason` field still says why.
 */
const DEGRADE_LOG_INTERVAL_MS = 60_000;
let lastDegradeLogAt = 0;

export type { CompactMessage, CompactToolCall };

/**
 * Which source answered.
 *
 * A NEGATIVE IS A CLAIM, so this is never inferred from an empty array. `live`
 * is the sandbox's own runtime endpoint; `mirror` is the durable server-side
 * copy written at turn end (`session-transcript-mirror.ts`); `none` is the
 * honest "nothing could answer", and it is the only value that ever accompanies
 * `available: false`. Mirror and live are NEVER merged — the field says which
 * one you got.
 *
 * The wire shapes live in `@kortix/api-contract`: `SessionTranscript` is the
 * compact digest, `SessionTranscriptSyncEnvelope` the sync-store window (the
 * runtime's message envelopes verbatim, every part 1:1 except attachment bytes,
 * see `sanitizeParts`; mirror-only, at most `limit` messages and
 * MIRROR_WINDOW_MAX_CHARS of JSON, newest first to be kept).
 */
export type {
  SessionTranscriptSource,
  SessionTranscript as SessionTranscriptDigest,
  SessionTranscriptSyncEnvelope,
} from '@kortix/api-contract';

/** Seam for tests: the mirror read is the one collaborator whose absence vs
 *  presence changes which branch the digest takes, and a DB is not needed to
 *  prove that. Production never passes it. */
export interface SessionTranscriptDeps {
  readMirror?: (
    sessionId: string,
    limit: number,
    before?: string | null,
    /** A sub-agent's OpenCode session; null reads the root. */
    opencodeSessionId?: string | null,
  ) => Promise<MirrorSnapshot | null>;
}

/** The runtime session id under its neutral name and its pre-W4 name. */
function runtimeSessionPin(id: string | null) {
  return { runtime_session_id: id, opencode_session_id: id };
}

export async function buildSessionTranscriptDigest(
  input: {
    session: ProjectSessionRow;
    projectId: string;
    accountId: string;
    userId: string;
    limit: number;
    maxChars: number;
    /** `compactMessage`'s `full` variant: line breaks plus tool input/output. */
    full?: boolean;
    /** Budget for the sandbox endpoint resolution. Tests inject a short one;
     *  prod uses {@link TRANSCRIPT_ENDPOINT_BUDGET_MS}. */
    endpointBudgetMs?: number;
  },
  deps: SessionTranscriptDeps = {},
): Promise<SessionTranscriptDigest> {
  const { session, projectId, accountId, userId, limit, maxChars, full = false } = input;
  const readMirror = deps.readMirror ?? readMirrorSafely;
  const startedAt = Date.now();

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
    // A degraded live attempt is otherwise invisible: `Request completed`
    // carries no why, so a p95 spike on this route had to be reconstructed
    // from durations alone. Rate-limited (see DEGRADE_LOG_INTERVAL_MS).
    // A stopped session degrades by design on every read — it stays silent.
    const now = Date.now();
    if (session.status === 'running' && now - lastDegradeLogAt >= DEGRADE_LOG_INTERVAL_MS) {
      lastDegradeLogAt = now;
      appLogger.info('[transcript] live read degraded to the mirror', {
        sessionId: session.sessionId,
        reason,
        elapsed_ms: now - startedAt,
      });
    }
    const mirror = await readMirror(session.sessionId, limit);
    if (mirror) {
      return {
        available: true,
        reason,
        source: 'mirror',
        complete: mirrorIsComplete(mirror),
        captured_at: mirror.captured_at,
        ...runtimeSessionPin(mirror.opencode_session_id ?? opencodeSessionId),
        message_count: mirror.messages.length,
        messages: mirror.messages.map((m) =>
          compactMessage({ info: m.info as never, parts: m.parts as never }, maxChars, full),
        ),
      };
    }
    return {
      available: false,
      reason,
      source: 'none',
      complete: false,
      captured_at: null,
      ...runtimeSessionPin(opencodeSessionId),
      message_count: 0,
      messages: [],
    };
  };

  if (session.status !== 'running') {
    return degrade(
      `session is ${session.status}; live transcript requires a running sandbox`,
      session.runtimeSessionId,
    );
  }

  const externalId = await resolveSessionExternalId({ session, projectId, accountId });
  if (!externalId) {
    return degrade('session has no reachable sandbox external id yet', session.runtimeSessionId);
  }

  // ONE endpoint resolution serves the pin check and the message fetch — it
  // is handed to `ensureOpencodeSessionPin` below instead of being resolved
  // again there. Resolution touches the sandbox provider (Daytona
  // preview-link / service-key lookup) and can throw on a 429
  // `ThrottlerException` rate limit, an archived/deleted box, a transient
  // provider outage, or simply hang — the provider SDK exposes no per-call
  // timeout, so the resolution is bounded with `withTimeout` and a hang
  // degrades to the mirror like any other unreachable box. This digest is
  // best-effort enrichment (the session row is already loaded); a provider
  // throw must NEVER bubble up and 500 the transcript read (see #3567 for
  // the sibling title-sync fix — this is the same class of bug on a
  // different post-#3567 call site).
  let endpoint: { url: string; headers: Record<string, string> } | null;
  try {
    endpoint = await withTimeout(
      sandboxOpencodeEndpoint(externalId, userId),
      input.endpointBudgetMs ?? TRANSCRIPT_ENDPOINT_BUDGET_MS,
      'sandbox endpoint resolution',
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return degrade(`could not reach sandbox: ${message}`, session.runtimeSessionId);
  }
  if (!endpoint) {
    return degrade('sandbox service key unavailable', session.runtimeSessionId);
  }

  const ensured = await ensureOpencodeSessionPin({
    projectId,
    sessionId: session.sessionId,
    accountId,
    externalId,
    userId,
    currentPin: session.runtimeSessionId,
    endpoint,
  });
  const opencodeSessionId = ensured.pin;
  if (!opencodeSessionId) {
    return degrade(opencodeReason(ensured.reason), null);
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
      ...runtimeSessionPin(opencodeSessionId),
      message_count: rawMessages.length,
      messages: rawMessages.map((m) => compactMessage(m, maxChars, full)),
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
    requireCurrentRoot?: boolean;
    /** A `next_cursor` from a previous window — read the window older than it. */
    before?: string | null;
    /** A sub-agent's OpenCode session inside this session: its own saved
     *  transcript. Omitted: the root conversation. */
    child?: string | null;
  },
  deps: SessionTranscriptDeps = {},
): Promise<SessionTranscriptSyncEnvelope> {
  const read = await (deps.readMirror ?? readMirrorSafely)(
    input.session.sessionId,
    input.limit,
    input.before ?? null,
    input.child ?? null,
  );
  // Bounded by size as well as by count: rows keep every tool payload 1:1, and
  // a cold open waits for this window. What does not fit is one cursor away.
  const mirror = read ? boundMirrorWindow(read, MIRROR_WINDOW_MAX_CHARS) : null;
  const mirrorRoot = mirror?.root_opencode_session_id ?? mirror?.opencode_session_id;
  const rootMismatch = input.requireCurrentRoot && (
    !input.session.runtimeSessionId || mirrorRoot !== input.session.runtimeSessionId
  );
  if (!mirror || rootMismatch) {
    return {
      available: false,
      reason: rootMismatch ? 'stored transcript does not match the current session root' : 'no server-side transcript has been captured for this session yet',
      source: 'none',
      complete: false,
      captured_at: null,
      ...runtimeSessionPin(input.child ?? input.session.runtimeSessionId),
      message_count: 0,
      total: 0,
      next_cursor: null,
      messages: [],
    };
  }
  return {
    available: true,
    reason: null,
    source: 'mirror',
    complete: mirrorIsComplete(mirror),
    captured_at: mirror.captured_at,
    ...runtimeSessionPin(mirror.opencode_session_id ?? input.session.runtimeSessionId),
    message_count: mirror.messages.length,
    total: mirror.total,
    next_cursor: mirror.next_cursor,
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
async function readMirrorSafely(
  sessionId: string,
  limit: number,
  before?: string | null,
  opencodeSessionId?: string | null,
): Promise<MirrorSnapshot | null> {
  try {
    return await readSessionTranscriptMirror({ sessionId, limit, before, opencodeSessionId });
  } catch (err) {
    // A cursor the caller supplied is the caller's error, not a mirror
    // failure, and swallowing it here would answer "nothing was captured" for
    // a session that holds a full history.
    if (err instanceof UnknownTranscriptCursorError) throw err;
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
