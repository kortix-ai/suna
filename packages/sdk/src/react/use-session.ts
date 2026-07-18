'use client';

/** Canonical ACP-only Kortix project-session lifecycle hook. */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { BillingError, parseBillingError } from '../core/http/api/errors';
import { isSessionFresh } from '../core/http/fresh-sessions';
import {
  isSessionStartError,
  type SessionStartResult,
  sessionStartKey,
  startProjectSession,
} from '../core/rest/projects-client';
import { setCurrentRuntime } from '../core/session/current-runtime';
import { extractGatewayErrorDetails } from '../core/turns/errors';
import { getSandboxUrlForExternalId } from '../browser/stores/server-store';
import { setRuntimeHealth, setSandboxStatus } from '../browser/stores/sandbox-connection-store';
import type { Session } from '../runtime/wire-types';
import { useAcpSession } from './use-acp-session';
import { runtimeKeys } from './use-runtime-sessions/keys';
import { useRuntimePhase } from './use-runtime-phase';

export type SessionPhase = 'starting' | 'ready' | 'error';
const FRESH_START_404_RETRIES = 12;
const FRESH_START_404_RETRY_DELAY_MS = 800;

export function shouldRetrySessionStart(failureCount: number, error: unknown, sessionId: string): boolean {
  if (isSessionStartError(error) && error.status === 404 && isSessionFresh(sessionId)) {
    return failureCount < FRESH_START_404_RETRIES;
  }
  return !isSessionStartError(error) && failureCount < 3;
}

export type KortixSendErrorKind = 'billing' | 'runtime-not-ready' | 'runtime-error';
export interface KortixSendError {
  kind: KortixSendErrorKind;
  message: string;
  billing?: BillingError;
  /**
   * Present when `kind === 'runtime-error'` and the failure carries the LLM
   * gateway's structured error envelope (provider/code/suggestion/...) — see
   * `extractGatewayErrorDetails`. Lets a host render WHICH provider failed and
   * WHAT to do about it instead of only the provider's raw error text.
   */
  gateway?: {
    provider?: string;
    code?: string;
    suggestion?: string;
    upstreamStatus?: number;
    requestId?: string;
  };
  cause: unknown;
}

export function classifySendError(error: unknown): KortixSendError {
  if (error instanceof Error && error.message.includes('Server URL not ready')) {
    return { kind: 'runtime-not-ready', message: 'The session runtime is still starting — try again in a moment.', cause: error };
  }
  if (error && typeof error === 'object') {
    const parsed = parseBillingError(error);
    if (parsed instanceof BillingError) {
      return { kind: 'billing', message: parsed.message, billing: parsed, cause: error };
    }
  }
  const gateway = extractGatewayErrorDetails(error);
  return {
    kind: 'runtime-error',
    // Prefer the gateway's own message (already human-written server-side per
    // status/cause) over the bare runtime-error text when present.
    message: gateway?.message || (error instanceof Error ? error.message : 'The runtime request failed.'),
    ...(gateway
      ? {
          gateway: {
            provider: gateway.provider,
            code: gateway.code,
            suggestion: gateway.suggestion,
            upstreamStatus: gateway.upstreamStatus,
            requestId: gateway.requestId,
          },
        }
      : {}),
    cause: error,
  };
}

export interface SendState { pending: string | null; sendError: KortixSendError | null }
export function sendStateOnStart(text: string): SendState { return { pending: text, sendError: null }; }
export function sendStateOnError(error: unknown): SendState { return { pending: null, sendError: classifySendError(error) }; }

/**
 * Pure phase decision for `useSession`. The load-bearing rule: once the ACP
 * session has EVER been ready (`acpReady` is sticky-true — see
 * `AcpSession`), a later terminal ACP error (a failed `session/prompt`
 * against a hibernated sandbox, a dropped stream) keeps the phase `'ready'`.
 * Hosts key their whole layout off the phase — flipping it mid-session used
 * to swap a live transcript's side panel back to the "Kortix Session is
 * starting" boot loader on the first failed send. Mid-session failures are
 * the chat surface's job to present (inline error rows, reconnect pills) and
 * the runtime-recovery loop's job to heal — never a layout regression to
 * boot chrome. A terminal ACP error BEFORE first readiness (dead sandbox at
 * bootstrap) is still a real `'error'`.
 */
export function computeSessionPhase(input: {
  /** `/start` reported a terminal stage (`failed`/`stopped`). */
  stageTerminal: boolean;
  startError: boolean;
  protocolError: boolean;
  switched: boolean;
  acpReady: boolean;
  /** `acp.errorInfo?.terminal` — a failure retrying cannot fix on its own. */
  acpErrorTerminal: boolean;
}): SessionPhase {
  if (input.stageTerminal || input.startError || input.protocolError) return 'error';
  if (input.acpErrorTerminal && !input.acpReady) return 'error';
  return input.switched && input.acpReady ? 'ready' : 'starting';
}

/** Backoff schedule for the dead-runtime recovery loop (`useSession`): the
 *  first re-`/start` fires near-immediately (matching what a hard refresh
 *  would do), then doubles from 2s, capped at 8s; `null` after
 *  `MAX_RUNTIME_RECOVERIES` attempts means give up and leave the terminal
 *  error to the host's retry affordances. */
export const MAX_RUNTIME_RECOVERIES = 5;
export function runtimeRecoveryDelayMs(attempt: number): number | null {
  if (attempt >= MAX_RUNTIME_RECOVERIES) return null;
  if (attempt === 0) return 500;
  return Math.min(2_000 * 2 ** (attempt - 1), 8_000);
}

export interface UseSessionOptions {
  waitMs?: number;
  replayStartStash?: boolean;
  enabled?: boolean;
  /** @deprecated ACP owns the conversation engine. */
  chatEngine?: boolean;
}

export function useSession(projectId: string, sessionId: string, options: UseSessionOptions = {}) {
  const { waitMs = 15_000, enabled = true, replayStartStash = true } = options;
  // The create-then-navigate flows seed the created row here (see
  // seedCreatedRuntimeSession) — its bound agent bridges the gap until the
  // first `/start` poll answers, so the composer never flashes a default
  // agent/model that isn't this session's.
  const queryClient = useQueryClient();
  const seededSession = queryClient.getQueryData<Session>(runtimeKeys.session(sessionId));
  const start = useQuery({
    queryKey: sessionStartKey(projectId, sessionId),
    queryFn: () => startProjectSession(projectId, sessionId, waitMs),
    enabled: enabled && !!projectId && !!sessionId,
    retry: (failureCount, error) => shouldRetrySessionStart(failureCount, error, sessionId),
    retryDelay: (failureCount, error) => isSessionStartError(error) && error.status === 404
      ? FRESH_START_404_RETRY_DELAY_MS
      : Math.min(1000 * 2 ** failureCount, 5000),
    refetchInterval: (query) => {
      if (isSessionStartError(query.state.error)) return false;
      const stage = (query.state.data as SessionStartResult | null | undefined)?.stage;
      return stage === 'ready' || stage === 'failed' || stage === 'stopped' ? false : 1500;
    },
  });
  const startData = start.data ?? null;
  const startError = isSessionStartError(start.error) ? start.error : null;
  const stage = startData?.stage ?? null;
  const sandbox = startData?.sandbox ?? null;
  const startReady = stage === 'ready';
  const terminal = stage === 'failed' || stage === 'stopped';
  const protocolError = startReady && startData?.runtime_protocol !== 'acp';

  // Keyed on `external_id` (the CONTAINER), not `sandbox_id` (the durable DB
  // row): a hibernated sandbox resumed by the recovery loop below keeps its
  // row id but comes back as a new container — keying on the row id left the
  // runtime URL pointed at the dead container after every resume.
  const [switchedExternalId, setSwitchedExternalId] = useState<string | null>(null);
  useEffect(() => {
    if (!startReady || !sandbox?.external_id || switchedExternalId === sandbox.external_id) return;
    setCurrentRuntime(getSandboxUrlForExternalId(sandbox.external_id), sandbox.external_id, sandbox.sandbox_id, projectId, sessionId);
    setSwitchedExternalId(sandbox.external_id);
  }, [sandbox, startReady, switchedExternalId]);
  useEffect(() => () => setCurrentRuntime(null), []);
  const switched = startReady && !!sandbox && switchedExternalId === sandbox.external_id;
  useEffect(() => {
    if (!switched) return;
    setSandboxStatus('connected');
    setRuntimeHealth(true);
  }, [switched]);

  const acp = useAcpSession({
    projectId,
    sessionId,
    runtimeSessionId: startData?.runtime_session_id ?? null,
    replayStartStash,
    enabled: switched && !protocolError,
  });
  const runtimePhase = useRuntimePhase();
  const phase: SessionPhase = computeSessionPhase({
    stageTerminal: terminal,
    startError: !!startError,
    protocolError,
    switched,
    acpReady: acp.ready,
    acpErrorTerminal: !!acp.errorInfo?.terminal,
  });

  // ── Dead-runtime auto-recovery ─────────────────────────────────────────
  // The start query stops polling forever once `stage === 'ready'` (see its
  // refetchInterval), so a sandbox that dies AFTER that — idle hibernation,
  // container eviction — is invisible to it: the ACP layer starts failing
  // terminally ("failed to resolve container IP … Is the Sandbox started?")
  // while `/start` still claims ready, and nothing would ever resume the
  // box. A hard refresh fixed it because its fresh `/start` POST hits the
  // backend's idempotent provision/resume path — so do exactly that here:
  // on a terminal ACP error while start reports ready, re-issue `/start`
  // and re-arm the ACP connection (`acp.retry()` re-runs bootstrap after a
  // failure). Each still-failing retry patches a NEW `errorInfo` object,
  // which re-fires this effect into its next backoff step; a bootstrap that
  // finally succeeds clears the error and resets the attempt counter.
  const recoveryAttemptsRef = useRef(0);
  const acpErrorInfo = acp.errorInfo;
  const acpReady = acp.ready;
  const retryAcp = acp.retry;
  const refetchStart = start.refetch;
  useEffect(() => {
    if (!acpErrorInfo?.terminal) {
      if (!acpErrorInfo && acpReady) recoveryAttemptsRef.current = 0;
      return;
    }
    if (!startReady) return;
    const delay = runtimeRecoveryDelayMs(recoveryAttemptsRef.current);
    if (delay == null) return;
    const timer = setTimeout(() => {
      recoveryAttemptsRef.current += 1;
      void refetchStart().finally(() => retryAcp());
    }, delay);
    return () => clearTimeout(timer);
  }, [acpErrorInfo, acpReady, startReady, refetchStart, retryAcp]);

  return {
    projectId,
    sessionId,
    runtimeProtocol: 'acp' as const,
    /** The immutable agent this project session is bound to (from `/start`,
     *  seeded from the create response before that answers) — used to lock the
     *  composer's agent/harness selectors. */
    agentName: startData?.agent_name ?? seededSession?.agent ?? null,
    runtimeId: startData?.runtime_id ?? null,
    runtimeSessionId: acp.runtimeSessionId ?? startData?.runtime_session_id ?? null,
    acp,
    phase,
    stage,
    sandbox,
    switched,
    retriable: startData?.retriable ?? false,
    startError: protocolError ? { status: 500, message: 'The session did not start an ACP runtime.' } : startError,
    runtimePhase,
    isBusy: acp.busy,
    isLoading: !acp.ready,
    isError: phase === 'error',
    reason: protocolError ? 'non_acp_runtime' : (startData?.reason ?? null),
    retry: () => void start.refetch(),
  };
}

export type UseSessionResult = ReturnType<typeof useSession>;
