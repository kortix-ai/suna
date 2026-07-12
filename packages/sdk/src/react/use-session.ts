'use client';

/** Canonical ACP-only Kortix project-session lifecycle hook. */
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { BillingError, parseBillingError } from '../platform/api/errors';
import { isSessionFresh } from '../platform/fresh-sessions';
import {
  isSessionStartError,
  type SessionStartResult,
  sessionStartKey,
  startProjectSession,
} from '../platform/projects-client';
import { setCurrentRuntime } from '../state/current-runtime';
import { getSandboxUrlForExternalId } from '../state/server-store';
import { setOpenCodeHealth, setSandboxStatus } from '../state/sandbox-connection-store';
import { useAcpSession } from './use-acp-session';
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
  return { kind: 'runtime-error', message: error instanceof Error ? error.message : 'The runtime request failed.', cause: error };
}

export interface SendState { pending: string | null; sendError: KortixSendError | null }
export function sendStateOnStart(text: string): SendState { return { pending: text, sendError: null }; }
export function sendStateOnError(error: unknown): SendState { return { pending: null, sendError: classifySendError(error) }; }

export interface UseSessionOptions {
  waitMs?: number;
  replayStartStash?: boolean;
  enabled?: boolean;
  /** @deprecated ACP owns the conversation engine. */
  chatEngine?: boolean;
}

export function useSession(projectId: string, sessionId: string, options: UseSessionOptions = {}) {
  const { waitMs = 15_000, enabled = true } = options;
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

  const [switchedSandboxId, setSwitchedSandboxId] = useState<string | null>(null);
  useEffect(() => {
    if (!startReady || !sandbox?.external_id || switchedSandboxId === sandbox.sandbox_id) return;
    setCurrentRuntime(getSandboxUrlForExternalId(sandbox.external_id), sandbox.external_id, sandbox.sandbox_id);
    setSwitchedSandboxId(sandbox.sandbox_id);
  }, [sandbox, startReady, switchedSandboxId]);
  useEffect(() => () => setCurrentRuntime(null), []);
  const switched = startReady && !!sandbox && switchedSandboxId === sandbox.sandbox_id;
  useEffect(() => {
    if (!switched) return;
    setSandboxStatus('connected');
    setOpenCodeHealth(true);
  }, [switched]);

  const acp = useAcpSession({
    projectId,
    sessionId,
    runtimeSessionId: startData?.runtime_session_id ?? null,
    enabled: switched && !protocolError,
  });
  const runtimePhase = useRuntimePhase();
  const phase: SessionPhase = terminal || startError || protocolError || acp.error
    ? 'error'
    : switched && acp.ready ? 'ready' : 'starting';

  return {
    projectId,
    sessionId,
    runtimeProtocol: 'acp' as const,
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
