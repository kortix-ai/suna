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

/**
 * A terminal surface is on screen NOW: the route renders an `InlineSessionError`
 * itself, so the boot shell may crossfade out immediately — holding it over the
 * message would only hide it.
 *
 * `chatSessionId` is deliberately NOT part of this. It used to be, and it meant
 * the route started the 300ms fade as soon as SessionChat could MOUNT — which
 * is earlier than SessionChat has anything to paint. The fade landed on that
 * component's own compact "starting" loader and then swapped again to the
 * transcript: two handovers for one arrival, seen as a flicker. The ordinary
 * path now waits for the chat's own `onContentReady`.
 */
export function sessionErrorSurfaceReady(input: {
  runtimeError: unknown;
  runtimeBootError: unknown;
}) {
  return Boolean(input.runtimeError || input.runtimeBootError);
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
