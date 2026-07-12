import { acpSessionEnvelopes, sessionSandboxes } from '@kortix/db';
import { projectAcpTranscript } from '@kortix/sdk/acp/transcript';
import { and, asc, desc, eq } from 'drizzle-orm';

import { db } from '../../shared/db';
import {
  ensureOpencodeSessionPin,
  sandboxOpencodeEndpoint,
} from '../opencode-mapping';
import type { ProjectSessionRow } from './serializers';

const WORKSPACE_DIRECTORY = '/workspace';

export interface CompactToolCall {
  tool: string;
  status: string | null;
}

export interface CompactMessage {
  role: string;
  created: string | null;
  completed: string | null;
  text: string;
  tools: CompactToolCall[];
  files: Array<{ filename: string | null; mime: string | null }>;
  reasoning_omitted: boolean;
  error: { name?: string; message?: string } | null;
}

export interface SessionTranscriptDigest {
  available: boolean;
  reason: string | null;
  opencode_session_id: string | null;
  message_count: number;
  messages: CompactMessage[];
}

function isAcpSession(session: ProjectSessionRow): boolean {
  return (session.metadata as Record<string, unknown> | null)?.runtime_protocol === 'acp';
}

type RawOpencodeMessage = {
  info?: {
    role?: string;
    time?: { created?: number; completed?: number };
    error?: { name?: string; message?: string } | null;
  };
  role?: string;
  time?: { created?: number; completed?: number };
  error?: { name?: string; message?: string } | null;
  parts?: RawOpencodePart[];
};

type RawOpencodePart = {
  type?: string;
  text?: string;
  synthetic?: boolean;
  tool?: string;
  state?: { status?: string };
  filename?: string;
  mime?: string;
};

export async function buildSessionTranscriptDigest(input: {
  session: ProjectSessionRow;
  projectId: string;
  accountId: string;
  userId: string;
  limit: number;
  maxChars: number;
}): Promise<SessionTranscriptDigest> {
  const { session, projectId, accountId, userId, limit, maxChars } = input;
  if (isAcpSession(session)) {
    const rows = await db.select({
      ordinal: acpSessionEnvelopes.ordinal,
      direction: acpSessionEnvelopes.direction,
      streamEventId: acpSessionEnvelopes.streamEventId,
      envelope: acpSessionEnvelopes.envelope,
      createdAt: acpSessionEnvelopes.createdAt,
    }).from(acpSessionEnvelopes).where(and(
      eq(acpSessionEnvelopes.projectId, projectId),
      eq(acpSessionEnvelopes.sessionId, session.sessionId),
    )).orderBy(asc(acpSessionEnvelopes.ordinal));
    const messages = projectAcpTranscript(rows.map((row) => ({
      ...row,
      createdAt: row.createdAt.toISOString(),
    })), { limit, maxChars });
    return {
      available: true,
      reason: null,
      opencode_session_id: null,
      message_count: messages.length,
      messages,
    };
  }
  const unavailable = (reason: string): SessionTranscriptDigest => ({
    available: false,
    reason,
    opencode_session_id: session.opencodeSessionId,
    message_count: 0,
    messages: [],
  });

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

  const endpoint = await sandboxOpencodeEndpoint(externalId, userId);
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
      headers: endpoint.headers,
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) {
      return {
        ...unavailable(await messageReadReason(res)),
        opencode_session_id: opencodeSessionId,
      };
    }
    const payload = (await res.json().catch(() => null)) as unknown;
    const rawMessages = normalizeMessageList(payload).slice(-limit);
    return {
      available: true,
      reason: null,
      opencode_session_id: opencodeSessionId,
      message_count: rawMessages.length,
      messages: rawMessages.map((m) => compactMessage(m, maxChars)),
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

function normalizeMessageList(payload: unknown): RawOpencodeMessage[] {
  const list = Array.isArray(payload)
    ? payload
    : typeof payload === 'object' && payload && 'messages' in payload && Array.isArray((payload as { messages?: unknown }).messages)
      ? (payload as { messages: unknown[] }).messages
      : [];
  return list.filter((m): m is RawOpencodeMessage => typeof m === 'object' && m !== null);
}

function compactMessage(msg: RawOpencodeMessage, maxChars: number): CompactMessage {
  const info = msg.info ?? msg;
  const parts = Array.isArray(msg.parts) ? msg.parts : [];
  const text = parts
    .filter((p) => p.type === 'text' && !p.synthetic && typeof p.text === 'string')
    .map((p) => p.text as string)
    .filter(Boolean)
    .join('\n');
  const tools = parts
    .filter((p) => p.type === 'tool')
    .map((p) => ({
      tool: p.tool ?? 'tool',
      status: p.state?.status ?? null,
    }));
  const files = parts
    .filter((p) => p.type === 'file')
    .map((p) => ({
      filename: p.filename ?? null,
      mime: p.mime ?? null,
    }));
  return {
    role: info.role ?? 'unknown',
    created: info.time?.created ? new Date(info.time.created).toISOString() : null,
    completed: info.time?.completed ? new Date(info.time.completed).toISOString() : null,
    text: truncate(normalizeWhitespace(text), maxChars),
    tools,
    files,
    reasoning_omitted: parts.some((p) => p.type === 'reasoning'),
    error: info.error ?? null,
  };
}

function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`;
}
