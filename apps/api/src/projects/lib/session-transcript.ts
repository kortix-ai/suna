import { acpSessionEnvelopes } from '@kortix/db';
import { projectAcpTranscript } from '@kortix/sdk/acp/transcript';
import { and, asc, eq } from 'drizzle-orm';

import { db } from '../../shared/db';
import { narrowAcpEnvelopeRows } from './acp-envelope-rows';
import type { ProjectSessionRow } from './serializers';

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
  runtime_session_id: string | null;
  message_count: number;
  messages: CompactMessage[];
}

function isAcpSession(session: ProjectSessionRow): boolean {
  return (session.metadata as Record<string, unknown> | null)?.runtime_protocol === 'acp';
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
    const messages = projectAcpTranscript(narrowAcpEnvelopeRows(rows), { limit, maxChars });
    return {
      available: true,
      reason: null,
      runtime_session_id: typeof session.metadata?.acp_session_id === 'string' ? session.metadata.acp_session_id : null,
      message_count: messages.length,
      messages,
    };
  }
  return {
    available: false,
    reason: 'Transcript export is only available for ACP sessions.',
    runtime_session_id: null,
    message_count: 0,
    messages: [],
  };
}
