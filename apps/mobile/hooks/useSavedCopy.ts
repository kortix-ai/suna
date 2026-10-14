/**
 * The saved copy of a session, for the connecting view: the thread to show
 * while the session's computer wakes, and whether the conversation is proven
 * empty. The SDK paints the copy into its session store (`useSessionSync`),
 * so the thread that opens next starts from the same messages.
 */
import { useEffect, useMemo, useState } from 'react';
import { sessionLogOfV1Rows, type SessionLogThread } from '@kortix/sdk';
import { useSessionSync } from '@kortix/sdk/react';
import { readSavedCopy, type SavedCopyRead } from '@/lib/session/saved-copy';

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
  const [read, setRead] = useState<({ key: string } & SavedCopyRead) | null>(null);
  useEffect(() => {
    if (!target || !key) return;
    let current = true;
    void readSavedCopy(target).then((result) => {
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
    // `null` until the server's copy answers: the copy this device kept paints
    // first, and the server's reconciles into it.
    mirror: mine?.envelope ?? null,
    savedChild: target?.child ?? false,
  });

  const rows = target && sync.messages.length > 0 ? sync.messages : null;
  const thread = useMemo(
    () => (target && rows ? sessionLogOfV1Rows(target.sessionId, target.rootId, rows).threads[0] : undefined),
    [target, rows],
  );
  return { thread, empty: mine?.empty ?? false };
}
