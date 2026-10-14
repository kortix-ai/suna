/**
 * The saved copy of a session, for the connecting view: the thread to show
 * while the session's computer wakes, and whether the conversation is proven
 * empty. The SDK reads it (`readSavedSessionCopy`, the same saved-history read
 * the web makes) and paints it into its session store (`useSessionSync`), so
 * the thread that opens next starts from the same messages. The SDK holds the
 * copy for that open: the thread downloads the window no second time.
 */
import { useEffect, useMemo, useState } from 'react';
import { readSavedSessionCopy, sessionLogOfV1Rows, type SavedSessionCopy, type SessionLogThread } from '@kortix/sdk';
import { useSessionSync } from '@kortix/sdk/react';

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
    // A sub-agent's window is read by `useSessionSync` below (`child=`).
    if (!target || !key || target.child) return;
    let current = true;
    void readSavedSessionCopy({
      projectId: target.projectId,
      sessionId: target.sessionId,
      runtimeSessionId: target.rootId,
    }).then((result) => {
      if (current) setRead({ key, ...result });
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
  });

  const rows = target && sync.messages.length > 0 ? sync.messages : null;
  const thread = useMemo(
    () => (target && rows ? sessionLogOfV1Rows(target.sessionId, target.rootId, rows).threads[0] : undefined),
    [target, rows],
  );
  return { thread, empty: mine?.empty ?? false };
}
