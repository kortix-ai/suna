import type {
  Event as OpenCodeSdkEvent,
  PermissionRequest,
  QuestionRequest,
} from '@opencode-ai/sdk/v2/client';
import type { QueryClient } from '@tanstack/react-query';
import type { RefObject } from 'react';
import type { getClient } from '../../core/runtime/client';
import type { SessionSyncReason } from '../../core/session-sync/session-sync-controller';
import type { NormalizeDiagnosticPaths } from './types';
export type HandlerContext = {
  queryClient: QueryClient;
  client: ReturnType<typeof getClient>;
  applySyncEvent: (event: OpenCodeSdkEvent) => void;
  stopCompaction: (sessionID: string) => void;
  addPermission: (req: PermissionRequest) => void;
  removePermission: (requestId: string) => void;
  addQuestion: (req: QuestionRequest) => void;
  removeQuestion: (requestId: string) => void;
  normalizeDiagnosticPaths: RefObject<NormalizeDiagnosticPaths>;
  markSessionAbortedLocally: RefObject<(sessionID: string, message?: string) => void>;
  fetchLspDiagnosticsDebounced: RefObject<() => void>;
  reconcileSessionTail?: (sessionID: string, reason: SessionSyncReason) => Promise<void>;
  userPartsGraceMs?: number;
  projectId?: string | null;
} & {
  reconcileTail: (
    sessionID: string,
    reason: import('../../core/session-sync/session-sync-controller').SessionSyncReason,
  ) => Promise<void>;
  getSessionTitle: (sessionID: string) => string | undefined;
  invalidateWorkspaceFilesAfterTurn: () => void;
  projectId: string | null;
  userPartsGraceMs: number;
};
