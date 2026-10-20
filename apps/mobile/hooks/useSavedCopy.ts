/**
 * The saved copy of a session, for the connecting view: the thread to show
 * while the session's computer wakes, and whether the conversation is proven
 * empty. The SDK reads it (`readSavedSessionCopy`, the same saved-history read
 * the web makes) and paints it into its session store, so the thread that opens
 * next starts from the same messages.
 *
 * - The project flag `session_log` off: the v1 copy (`useSessionSync` paints
 *   it). The SDK holds the copy for the open: the thread downloads the window
 *   no second time.
 * - On: the session log's newest page (`GET …/log`), never the v1 copy. A
 *   sub-agent's thread loads from the heads that page names
 *   (`useSessionLogThread`). Nothing is read until the flag answers.
 */
import { useEffect, useMemo, useState } from 'react';
import { readSavedSessionCopy, sessionLogOfV1Rows, type SavedSessionCopy, type SessionLogThread } from '@kortix/sdk';
import { useFeatureFlag, useSessionLogThread, useSessionStateStore, useSessionSync } from '@kortix/sdk/react';

export interface SavedCopyTarget {
  projectId: string;
  /** The Kortix session id. */
  sessionId: string;
  /** The runtime session the copy belongs to: the root, or a sub-agent's. */
  rootId: string;
  child: boolean;
}

export function useSavedCopy(target: SavedCopyTarget | null): {
  /** The copy as a session-log thread (the `fromV1` view of its rows); undefined while it holds no message. */
  thread: SessionLogThread | undefined;
  empty: boolean;
} {
  const flag = useFeatureFlag(target?.projectId ?? null, 'session_log');
  const sessionLog = flag.enabled;
  const key =
    target && !flag.isLoading
      ? `${target.projectId}/${target.sessionId}/${target.rootId}/${target.child ? 'child' : 'root'}/${sessionLog ? 'log' : 'v1'}`
      : null;
  const [read, setRead] = useState<({ key: string } & SavedSessionCopy) | null>(null);
  useEffect(() => {
    // On v1 a sub-agent's window is read by `useSessionSync` below (`child=`).
    if (!target || !key || (target.child && !sessionLog)) return;
    let current = true;
    void readSavedSessionCopy({
      projectId: target.projectId,
      sessionId: target.sessionId,
      runtimeSessionId: target.rootId,
      sessionLog,
    }).then((result) => {
      if (!current) return;
      // The SDK's session store holds the page, as `useSession` will.
      if (result.log) useSessionStateStore.getState().applySessionLogPage(target.sessionId, result.log);
      setRead({ key, ...result });
    });
    return () => {
      current = false;
    };
    // `key` names every field of `target` this effect reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const mine = read && read.key === key ? read : null;

  const sync = useSessionSync(target?.rootId ?? '', {
    kortixSessionScope: target ? `${target.projectId}/${target.sessionId}` : undefined,
    // The computer is not up yet: only the saved copies paint.
    networkEnabled: false,
    // The root: the copy read above, `null` until it answers (the copy this
    // device kept paints first, and the server's reconciles into it). A
    // sub-agent: `undefined`, so the SDK reads its own window.
    mirror: target?.child ? undefined : (mine?.envelope ?? null),
    savedChild: target?.child ?? false,
    // No v1 copy while the flag is unknown, nor with it on.
    sessionLog: !key || sessionLog,
  });

  const rows = target && sync.messages.length > 0 ? sync.messages : null;
  const v1Thread = useMemo(
    () => (target && rows ? sessionLogOfV1Rows(target.sessionId, target.rootId, rows).threads[0] : undefined),
    [target, rows],
  );
  const source = useMemo(
    () => ({ projectId: target?.projectId ?? '', sessionId: target?.sessionId ?? '', runtimeSessionId: target?.rootId ?? null }),
    [target?.projectId, target?.sessionId, target?.rootId],
  );
  const logThread = useSessionLogThread(source, target?.child ? target.rootId : undefined);
  const thread = !sessionLog ? v1Thread : target && logThread?.messages.length ? logThread : undefined;
  return { thread, empty: mine?.empty ?? false };
}
