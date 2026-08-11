'use client';

import { KortixWorkspaceProvider } from '@kortix/sdk/react';
import { useParams } from 'next/navigation';

/**
 * Bridges Next's router into the router-agnostic SDK: derives the route's
 * workspace id the same way the hooks did when they read `useParams()` themselves
 * (any `[id]` segment), and injects it once for the whole app.
 */
export function KortixWorkspaceScope({ children }: { children: React.ReactNode }) {
  const params = useParams();
  const workspaceId = typeof params?.id === 'string' ? params.id : null;
  return <KortixWorkspaceProvider workspaceId={workspaceId}>{children}</KortixWorkspaceProvider>;
}
