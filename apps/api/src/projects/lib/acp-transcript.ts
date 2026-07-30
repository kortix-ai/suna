import { acpSessionEnvelopes } from '@kortix/db';
import { and, asc, eq, gt } from 'drizzle-orm';

import { db } from '../../shared/db';

export type AcpEnvelopeDirection = 'client_to_agent' | 'agent_to_client';

export type StoredAcpEnvelope = {
  ordinal: number;
  direction: AcpEnvelopeDirection;
  streamEventId: number | null;
  envelope: Record<string, unknown>;
  createdAt: string;
};

export async function appendAcpEnvelope(input: {
  projectId: string;
  sessionId: string;
  runtimeInstanceId: string;
  direction: AcpEnvelopeDirection;
  envelope: Record<string, unknown>;
  upstreamEventId?: number | null;
}): Promise<{ ordinal: number; envelope: Record<string, unknown> }> {
  const upstreamEventId = input.upstreamEventId ?? null;
  const values = {
    projectId: input.projectId,
    sessionId: input.sessionId,
    runtimeInstanceId: input.runtimeInstanceId,
    direction: input.direction,
    upstreamEventId,
    envelope: input.envelope,
  };
  const inserted = await db
    .insert(acpSessionEnvelopes)
    .values(values)
    .onConflictDoNothing()
    .returning({
      ordinal: acpSessionEnvelopes.ordinal,
      envelope: acpSessionEnvelopes.envelope,
    });
  if (inserted[0]) return inserted[0];

  if (upstreamEventId === null) {
    throw new Error('ACP envelope insert returned no row');
  }
  const [existing] = await db
    .select({
      ordinal: acpSessionEnvelopes.ordinal,
      envelope: acpSessionEnvelopes.envelope,
    })
    .from(acpSessionEnvelopes)
    .where(
      and(
        eq(acpSessionEnvelopes.sessionId, input.sessionId),
        eq(acpSessionEnvelopes.direction, input.direction),
        eq(acpSessionEnvelopes.runtimeInstanceId, input.runtimeInstanceId),
        eq(acpSessionEnvelopes.upstreamEventId, upstreamEventId),
      ),
    )
    .limit(1);
  if (!existing) {
    throw new Error('ACP envelope conflict row was not found');
  }
  return existing;
}

export async function loadAcpTranscript(input: {
  projectId: string;
  sessionId: string;
  afterOrdinal?: number;
}): Promise<StoredAcpEnvelope[]> {
  const afterOrdinal = input.afterOrdinal ?? 0;
  const rows = await db
    .select({
      ordinal: acpSessionEnvelopes.ordinal,
      direction: acpSessionEnvelopes.direction,
      streamEventId: acpSessionEnvelopes.upstreamEventId,
      envelope: acpSessionEnvelopes.envelope,
      createdAt: acpSessionEnvelopes.createdAt,
    })
    .from(acpSessionEnvelopes)
    .where(
      and(
        eq(acpSessionEnvelopes.projectId, input.projectId),
        eq(acpSessionEnvelopes.sessionId, input.sessionId),
        ...(afterOrdinal > 0 ? [gt(acpSessionEnvelopes.ordinal, afterOrdinal)] : []),
      ),
    )
    .orderBy(asc(acpSessionEnvelopes.ordinal));

  return rows.flatMap((row) => {
    if (row.direction !== 'client_to_agent' && row.direction !== 'agent_to_client') {
      return [];
    }
    return [
      {
        ordinal: row.ordinal,
        direction: row.direction,
        streamEventId: row.streamEventId,
        envelope: row.envelope,
        createdAt: row.createdAt.toISOString(),
      },
    ];
  });
}
