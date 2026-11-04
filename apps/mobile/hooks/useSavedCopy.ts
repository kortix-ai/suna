/**
 * The saved copy of a session, for the connecting view: the thread to show
 * while the session's computer wakes, and whether the conversation is proven
 * empty. The SDK reads it (`readSavedSessionCopy`, the same saved-history read
 * the web makes) and paints it into its session store, so the thread that opens
 * next starts from the same messages.
 *
 * - The session log: its newest page (`GET …/log`). A sub-agent's thread
 *   loads from the heads that page names (`useSessionLogThread`).
 * - No page (a new session, a failed read): the copy this device kept, if any.
 *
 * No project flag is read, and no v1 transcript (`GET …/transcript`).
 */
import { useEffect, useMemo, useState } from 'react';
import { readSavedSessionCopy, sessionLogOfV1Rows, type SavedSessionCopy, type SessionLogThread } from '@kortix/sdk';
import { useSessionLogRecord, useSessionLogThread, useSessionStateStore, useSessionSync } from '@kortix/sdk/react';

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
  const key = target ? `${target.projectId}/${target.sessionId}/${target.rootId}/${target.child ? 'child' : 'root'}` : null;
  const [read, setRead] = useState<({ key: string } & SavedSessionCopy) | null>(null);
  useEffect(() => {
    // A sub-agent: `useSessionSync` below reads the log.
    if (!target || !key || target.child) return;
    let current = true;
    void readSavedSessionCopy({
      projectId: target.projectId,
      sessionId: target.sessionId,
      runtimeSessionId: target.rootId,
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
  // The store holds the session's log: the page above, or the one `useSessionSync` read for a sub-agent.
  const onLog = useSessionLogRecord({ sessionId: target?.sessionId ?? '' }) !== null;

  const sync = useSessionSync(target?.rootId ?? '', {
    kortixSessionScope: target ? `${target.projectId}/${target.sessionId}` : undefined,
    // The computer is not up yet: only the saved copies paint.
    networkEnabled: false,
    // The root: no copy from the network (the read above put the log page in the
    // store). A sub-agent: `undefined`, so the SDK reads the log itself.
    mirror: target?.child ? undefined : null,
    savedChild: target?.child ?? false,
    // The root: no device copy until the read answers that the session has no log page.
    sessionLog: !target?.child && (!mine || !!mine.log),
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
  const thread = !onLog ? v1Thread : target && logThread?.messages.length ? logThread : undefined;
  return { thread, empty: mine?.empty ?? false };
}
