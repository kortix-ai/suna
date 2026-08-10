import type { UseSessionResult } from '@kortix/sdk/react';

export function gatedRuntimeError(input: {
  phase: UseSessionResult['phase'];
  runtimeError: unknown;
}): unknown {
  return input.phase === 'error' ? input.runtimeError : null;
}

export function canMountSessionChat(input: {
  switched: boolean;
  opencodeSessionId: string | null;
}) {
  return input.switched || Boolean(input.opencodeSessionId);
}

export function findInitialSessionPin(
  sessions:
    | Array<{
        session_id: string;
        opencode_session_id: string | null;
      }>
    | undefined,
  sessionId: string,
) {
  return sessions?.find((session) => session.session_id === sessionId)?.opencode_session_id ?? null;
}

export function canShowSessionChat(input: {
  chatSessionId: string | null;
  runtimeError: unknown;
  runtimeBootError: unknown;
}) {
  return Boolean(input.chatSessionId || input.runtimeError || input.runtimeBootError);
}

export function resolveSessionContentState(input: {
  runtimeReady: boolean;
  sessionFetched: boolean;
  hasRuntimeSession: boolean;
  hasMessages: boolean;
  hasOptimisticPrompt: boolean;
}) {
  const sessionResolved = input.runtimeReady && input.sessionFetched;
  const isNotFound =
    !input.hasRuntimeSession && sessionResolved && !input.hasMessages && !input.hasOptimisticPrompt;
  const isDataLoading =
    !input.hasRuntimeSession && !isNotFound && !input.hasMessages && !input.hasOptimisticPrompt;

  return { isNotFound, isDataLoading };
}
