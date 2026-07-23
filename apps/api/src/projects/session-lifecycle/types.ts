import type { ProjectRow, ProjectSessionRow, RequestAuditContext } from '../lib/serializers';
import type { SessionCreateError } from '../lib/sessions';
import type { SessionStartResult } from '../routes/shared';

export type SessionInvocationSource =
  | 'ui'
  | 'mobile'
  | 'cli'
  | 'slack'
  | 'email'
  | 'telegram'
  | 'teams'
  | 'meet'
  | 'trigger:webhook'
  | 'trigger:cron'
  | 'trigger:manual'
  | 'system:sandbox-build-fix'
  | 'system:approval-resume'
  | 'admin';

export type QueuePolicy = 'never' | 'on_backpressure' | 'always';

export type SessionLifecyclePostCreateAction =
  | {
      type: 'bind_chat_thread';
      platform: 'slack' | 'telegram' | string;
      workspaceId: string;
      threadId: string;
    }
  | {
      type: 'deliver_prompt';
      source: SessionInvocationSource;
      text: string;
      userId?: string | null;
    };

export type SessionLifecycleStatus =
  | 'created'
  | 'ready'
  | 'continued'
  | 'queued'
  | 'pending'
  | 'deduped'
  | 'failed'
  | 'deleted';

export interface CreateSessionCommand {
  source: SessionInvocationSource;
  project: ProjectRow;
  userId: string;
  requestingPrincipalType: 'human' | 'service_account';
  body: Record<string, unknown>;
  visibility?: 'private' | 'project' | 'restricted';
  mayManageSystemConnectorProfiles?: boolean;
  metadata?: Record<string, unknown>;
  extraEnvVars?: Record<string, string>;
  enforceAccountCap?: boolean;
  request?: RequestAuditContext;
  idempotencyKey?: string | null;
  queuePolicy?: QueuePolicy;
  postCreate?: SessionLifecyclePostCreateAction[];
  // Caller's token kind (auth.ts `authType`) + apiKeyType + whether the token
  // operates from inside a running session (`inSession`: session-bound or
  // agent-scoped); used only to derive the session origin (a not-in-session
  // service_account / pat / 'user' apiKey → backend). Never trusted from the
  // request body. See session-origin.ts.
  authType?: string | null;
  apiKeyType?: string | null;
  inSession?: boolean | null;
}

export interface QueuedCreateSessionPayload {
  body: Record<string, unknown>;
  /** Absent on commands persisted before principal type was added. */
  requestingPrincipalType?: 'human' | 'service_account';
  metadata?: Record<string, unknown>;
  extraEnvVars?: Record<string, string>;
  visibility?: 'private' | 'project' | 'restricted';
  mayManageSystemConnectorProfiles?: boolean;
  enforceAccountCap?: boolean;
  postCreate?: SessionLifecyclePostCreateAction[];
  // Origin-derivation signals captured at ENQUEUE time. Without them a queued
  // backend create would replay as origin 'user' and 403 its origin_ref
  // asynchronously — after the caller already got a 202. Absent on rows queued
  // before this field existed → 'user', matching their pre-origin behavior.
  authType?: string | null;
  apiKeyType?: string | null;
  inSession?: boolean | null;
}

export interface ContinueSessionCommand {
  source: SessionInvocationSource;
  sessionId: string;
  text: string;
  userId?: string | null;
}

export interface StartSessionCommand {
  source: SessionInvocationSource;
  loaded: { row: ProjectRow; userId: string };
  visible: {
    row: {
      status: string;
      sandboxProvider: string;
      baseRef: string | null;
      agentName: string | null;
      accountId: string;
      metadata?: Record<string, unknown> | null;
    };
  };
  projectId: string;
  sessionId: string;
  /** Optional server-side long-poll budget (ms). When set, startSession keeps
   *  re-resolving readiness until ready/terminal or this deadline, so the client
   *  learns `ready` the instant it flips instead of on its own poll tick.
   *  Bounded server-side (START_AWAIT_MAX_MS); omit/0 = original one-shot. */
  waitMs?: number;
}

export type SessionDeliveryOutcome = 'delivered' | 'pending' | 'no-session' | 'failed';

export interface SessionLifecycleResult {
  status: SessionLifecycleStatus;
  commandId?: string;
  sessionId?: string;
  row?: ProjectSessionRow;
  start?: SessionStartResult;
  delivery?: SessionDeliveryOutcome;
  deduped?: boolean;
  retryable?: boolean;
  reason?: string;
  error?: SessionCreateError | { status: number; body: Record<string, unknown> };
  headers?: Record<string, string>;
}
