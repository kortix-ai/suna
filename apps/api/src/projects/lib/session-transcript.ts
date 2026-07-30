import { sessionSandboxes } from '@kortix/db';
import { and, desc, eq } from 'drizzle-orm';

import {
  type CompactMessage,
  compactAcpEnvelopes,
  compactOpencodeMessages,
} from '../../shared/compact-transcript';
import { db } from '../../shared/db';
import {
  ensureOpencodeSessionPin,
  sandboxOpencodeEndpoint,
} from '../opencode-mapping';
import { readManagedAcpSessionIdentity } from '../runtime-inspection';
import { sandboxRuntimeRequestHeaders } from '../sandbox-fetch';
import { loadAcpTranscript } from './acp-transcript';
import type { ProjectSessionRow } from './serializers';

const WORKSPACE_DIRECTORY = '/workspace';

export type { CompactFileRef, CompactMessage, CompactToolCall } from '../../shared/compact-transcript';

export interface SessionTranscriptDigest {
  available: boolean;
  reason: string | null;
  opencode_session_id: string | null;
  message_count: number;
  messages: CompactMessage[];
}

export async function buildSessionTranscriptDigest(input: {
  session: ProjectSessionRow;
  projectId: string;
  accountId: string;
  userId: string;
  limit: number;
  maxChars: number;
}): Promise<SessionTranscriptDigest> {
  const { session, projectId, accountId, userId, limit, maxChars } = input;
  const unavailable = (reason: string): SessionTranscriptDigest => ({
    available: false,
    reason,
    opencode_session_id: session.opencodeSessionId,
    message_count: 0,
    messages: [],
  });

  // ACP sessions are served from `kortix.acp_session_envelopes`, never from the
  // sandbox. Managed ACP never mints an OpenCode REST pin
  // (projects/lib/sessions.ts writes none) and never starts the in-sandbox REST
  // server (kortix-sandbox-agent-server main.ts skips opencode.start()), so the
  // REST read below is structurally dead for every ACP harness. The envelope
  // log is durable in Postgres, which also means a stopped or destroyed sandbox
  // still has a readable transcript — hence this runs BEFORE the
  // `status !== 'running'` gate.
  const acpIdentity = readManagedAcpSessionIdentity(
    (session.metadata ?? {}) as Record<string, unknown>,
  );
  if (acpIdentity) {
    return buildAcpTranscriptDigest({ session, projectId, limit, maxChars });
  }

  if (session.status !== 'running') {
    return unavailable(`session is ${session.status}; live transcript requires a running sandbox`);
  }

  const externalId = await resolveSessionExternalId({ session, projectId, accountId });
  if (!externalId) {
    return unavailable('session has no reachable sandbox external id yet');
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
    return {
      ...unavailable(opencodeReason(ensured.reason)),
      opencode_session_id: null,
    };
  }

  // Endpoint resolution touches the sandbox provider (Daytona preview-link /
  // service-key lookup) and can throw on a 429 `ThrottlerException` rate limit,
  // an archived/deleted box, or a transient provider outage. This digest is
  // best-effort enrichment (the session row is already loaded); a provider
  // throw must NEVER bubble up and 500 the transcript read (see #3567 for the
  // sibling title-sync fix — this is the same class of bug on a different
  // post-#3567 call site). Degrade to an unavailable digest instead.
  let endpoint: { url: string; headers: Record<string, string> } | null;
  try {
    endpoint = await sandboxOpencodeEndpoint(externalId, userId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ...unavailable(`could not reach sandbox: ${message}`),
      opencode_session_id: opencodeSessionId,
    };
  }
  if (!endpoint) {
    return {
      ...unavailable('sandbox service key unavailable'),
      opencode_session_id: opencodeSessionId,
    };
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
      return {
        ...unavailable(await messageReadReason(res)),
        opencode_session_id: opencodeSessionId,
      };
    }
    const payload = (await res.json().catch(() => null)) as unknown;
    const messages = compactOpencodeMessages(payload, { limit, maxChars });
    return {
      available: true,
      reason: null,
      opencode_session_id: opencodeSessionId,
      message_count: messages.length,
      messages,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ...unavailable(`could not read sandbox transcript: ${message}`),
      opencode_session_id: opencodeSessionId,
    };
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

/**
 * ACP transcript, folded from the durable envelope log. No sandbox call, no
 * OpenCode pin: minting one would need a REST server this transport never
 * starts, and is structurally impossible for the claude/codex/pi harnesses.
 * Every ACP harness is read identically — nothing here branches on which one.
 *
 * `available` is true even with zero envelopes: an ACP session that has not
 * spoken yet has an empty transcript, not an error.
 */
async function buildAcpTranscriptDigest(input: {
  session: ProjectSessionRow;
  projectId: string;
  limit: number;
  maxChars: number;
}): Promise<SessionTranscriptDigest> {
  const { session, projectId, limit, maxChars } = input;
  const metadata = (session.metadata ?? {}) as Record<string, unknown>;
  const acpSessionId =
    typeof metadata.acp_session_id === 'string' && metadata.acp_session_id.trim()
      ? metadata.acp_session_id
      : null;
  try {
    const envelopes = await loadAcpTranscript({ projectId, sessionId: session.sessionId });
    const messages = compactAcpEnvelopes(envelopes, { acpSessionId, limit, maxChars });
    return {
      available: true,
      reason: null,
      // Deliberately null for ACP: there is no OpenCode REST session to pin.
      opencode_session_id: null,
      message_count: messages.length,
      messages,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      available: false,
      reason: `could not read ACP transcript: ${message}`,
      opencode_session_id: null,
      message_count: 0,
      messages: [],
    };
  }
}
