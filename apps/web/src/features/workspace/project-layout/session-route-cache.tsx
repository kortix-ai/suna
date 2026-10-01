'use client';

import { usePathname } from 'next/navigation';
import { Activity, type ReactNode, useState } from 'react';

const MAX_CACHED_SESSIONS = 3;
const SESSION_PATH = /\/projects\/[^/]+\/sessions\/([^/?#]+)\/?$/;

/** Keep recently visited session trees alive while the project shell stays mounted. */
export function SessionRouteCache({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const sessionId = pathname.match(SESSION_PATH)?.[1];
  const [cached, setCached] = useState<{ id: string; children: ReactNode }[]>([]);

  // Update during render so returning to a session never paints the previous route.
  if (sessionId && (cached.at(-1)?.id !== sessionId || cached.at(-1)?.children !== children)) {
    setCached((previous) => [
      ...previous.filter((entry) => entry.id !== sessionId),
      { id: sessionId, children },
    ].slice(-MAX_CACHED_SESSIONS));
  }

  return (
    <>
      {cached.map((entry) => (
        <Activity key={entry.id} mode={sessionId === entry.id ? 'visible' : 'hidden'}>
          {entry.children}
        </Activity>
      ))}
      {!sessionId && children}
    </>
  );
}
