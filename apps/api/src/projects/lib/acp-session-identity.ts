import type { Database } from '@kortix/db';
import { projectSessions } from '@kortix/db';
import type { HarnessId } from '@kortix/shared/harnesses';
import { and, eq } from 'drizzle-orm';

export type AcpSessionIdentity = {
  acp_server_id: string;
  runtime_harness: HarnessId;
  acp_session_id: string;
};

export type AcpSessionIdentityErrorCode =
  | 'ACP_SESSION_NOT_FOUND'
  | 'ACP_SESSION_ID_REQUIRED'
  | 'ACP_TRANSPORT_REQUIRED'
  | 'ACP_SERVER_ID_MISMATCH'
  | 'ACP_HARNESS_MISMATCH'
  | 'ACP_SESSION_ID_CONFLICT'
  | 'ACP_IDENTITY_OVERLOAD';

export class AcpSessionIdentityConflictError extends Error {
  constructor(
    readonly code: AcpSessionIdentityErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AcpSessionIdentityConflictError';
  }
}

export async function persistAcpSessionIdentity(
  deps: { db: Database },
  input: {
    projectId: string;
    projectSessionId: string;
    acpServerId: string;
    runtimeHarness: HarnessId;
    acpSessionId: string;
  },
): Promise<AcpSessionIdentity> {
  const acpSessionId = input.acpSessionId.trim();
  if (!acpSessionId) {
    throw new AcpSessionIdentityConflictError(
      'ACP_SESSION_ID_REQUIRED',
      'acp_session_id must be a non-empty string',
    );
  }
  if (acpSessionId === input.acpServerId) {
    throw new AcpSessionIdentityConflictError(
      'ACP_IDENTITY_OVERLOAD',
      'acp_session_id must differ from acp_server_id',
    );
  }

  return deps.db.transaction(async (tx) => {
    const where = and(
      eq(projectSessions.sessionId, input.projectSessionId),
      eq(projectSessions.projectId, input.projectId),
    );
    const [row] = await tx
      .select({ metadata: projectSessions.metadata })
      .from(projectSessions)
      .where(where)
      .limit(1)
      .for('update');

    if (!row) {
      throw new AcpSessionIdentityConflictError(
        'ACP_SESSION_NOT_FOUND',
        'project session not found',
      );
    }

    const metadata = (row.metadata ?? {}) as Record<string, unknown>;
    if (metadata.runtime_transport !== 'acp') {
      throw new AcpSessionIdentityConflictError(
        'ACP_TRANSPORT_REQUIRED',
        'project session does not use ACP transport',
      );
    }
    if (metadata.acp_server_id !== input.acpServerId) {
      throw new AcpSessionIdentityConflictError(
        'ACP_SERVER_ID_MISMATCH',
        'acp_server_id does not match the immutable project session binding',
      );
    }
    if (metadata.runtime_harness !== input.runtimeHarness) {
      throw new AcpSessionIdentityConflictError(
        'ACP_HARNESS_MISMATCH',
        'runtime_harness does not match the immutable project session binding',
      );
    }

    const existingSessionId =
      typeof metadata.acp_session_id === 'string' && metadata.acp_session_id.trim()
        ? metadata.acp_session_id
        : null;
    if (existingSessionId && existingSessionId !== acpSessionId) {
      throw new AcpSessionIdentityConflictError(
        'ACP_SESSION_ID_CONFLICT',
        'acp_session_id is immutable after the first successful session/new response',
      );
    }

    const identity: AcpSessionIdentity = {
      acp_server_id: input.acpServerId,
      runtime_harness: input.runtimeHarness,
      acp_session_id: acpSessionId,
    };
    if (existingSessionId === acpSessionId) return identity;

    await tx
      .update(projectSessions)
      .set({
        metadata: {
          ...metadata,
          acp_session_id: acpSessionId,
        },
        updatedAt: new Date(),
      })
      .where(where);
    return identity;
  });
}
