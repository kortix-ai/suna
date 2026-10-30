'use client';

import { isSessionStartError, sessionStartKey } from '@kortix/sdk';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';

/** The route owns the lifetime of every session-specific reader. */
export function MissingSessionBoundary({
  projectId,
  sessionId,
  children,
  fallback,
}: {
  projectId: string;
  sessionId: string;
  children: ReactNode;
  fallback: ReactNode;
}) {
  const start = useQuery({
    queryKey: sessionStartKey(projectId, sessionId),
    queryFn: () => null,
    enabled: false,
  });
  // A fresh session's create/start race still retries: Query only publishes an
  // error after those retries finish. Cached session data is not a missing row.
  const missing =
    start.isError && isSessionStartError(start.error) && start.error.status === 404 && !start.data;
  return missing ? fallback : children;
}
