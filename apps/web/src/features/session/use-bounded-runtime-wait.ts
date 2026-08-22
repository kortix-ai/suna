'use client';

import { useEffect, useState } from 'react';

export const RUNTIME_TOOL_WAIT_MS = 15_000;

/** Converts an indefinite runtime-tool spinner into a local retry state. */
export function useBoundedRuntimeWait(waiting: boolean, attempt: number): boolean {
  const [expired, setExpired] = useState(false);

  useEffect(() => {
    // Reset belongs to the external timer lifecycle. The next macrotask avoids
    // a synchronous effect-driven render while still clearing a prior attempt.
    const reset = window.setTimeout(() => setExpired(false), 0);
    if (!waiting) return () => window.clearTimeout(reset);
    const timeout = window.setTimeout(() => setExpired(true), RUNTIME_TOOL_WAIT_MS);
    return () => {
      window.clearTimeout(reset);
      window.clearTimeout(timeout);
    };
  }, [attempt, waiting]);

  return waiting && expired;
}
