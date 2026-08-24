import type { UseSessionResult } from '@kortix/sdk/react';

export function gatedRuntimeError(input: {
  phase: UseSessionResult['phase'];
  runtimeError: unknown;
}): unknown {
  return input.phase === 'error' ? input.runtimeError : null;
}

/**
 * Runtime transport loss is local to the live layer when the conversation has
 * a resolved OpenCode identity. The cached transcript remains useful and must
 * not be replaced by a full-page error.
 */
export function runtimeErrorPresentation(input: {
  chatSessionId: string | null;
  runtimeError: unknown;
  runtimeBootError: unknown;
}): { replaceSession: boolean; inlineRecovery: boolean } {
  const hasRuntimeError = Boolean(input.runtimeError || input.runtimeBootError);
  if (!hasRuntimeError) return { replaceSession: false, inlineRecovery: false };
  if (input.chatSessionId) return { replaceSession: false, inlineRecovery: true };
  return { replaceSession: true, inlineRecovery: false };
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
  /**
   * A message read has SUCCEEDED for this session — `useSessionSync`'s
   * `isLoading === false`, which the store sets only when an authoritative read
   * lands.
   *
   * Without this, "the session object exists" was taken as proof the
   * conversation had been read, and those are two different requests. The
   * session GET is small and lands first; the message read is the big one and
   * is the one that loses to a waking box. When it lost, the page rendered the
   * full shell — header, composer, empty thread — over a session with a long
   * history, and the user saw an EMPTY CONVERSATION rather than a wait
   * (screenshot, essentia 2026-08-24: composer live, thread blank, runtime
   * terminal holding the whole session).
   *
   * Optional so existing callers keep their behaviour; `undefined` means the
   * caller does not track it and the old rule applies.
   */
  transcriptLoaded?: boolean;
}) {
  const sessionResolved = input.runtimeReady && input.sessionFetched;
  const isNotFound =
    !input.hasRuntimeSession && sessionResolved && !input.hasMessages && !input.hasOptimisticPrompt;
  // Nothing to paint AND nothing read yet. Either half alone is not enough:
  // a session with zero messages that HAS been read is genuinely empty and must
  // render its composer, and a session whose read has not landed must wait
  // however complete the rest of its metadata looks.
  const nothingToPaint = !input.hasMessages && !input.hasOptimisticPrompt;
  const readOutstanding = input.transcriptLoaded === false;
  const isDataLoading =
    !isNotFound && nothingToPaint && (!input.hasRuntimeSession || readOutstanding);

  return { isNotFound, isDataLoading };
}
