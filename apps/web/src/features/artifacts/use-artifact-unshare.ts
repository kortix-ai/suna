'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

type State = { open: boolean; status: 'idle' | 'loading' | 'ready' | 'error'; count: number };

export function useArtifactUnshare(readCount?: () => Promise<number>) {
  const request = useRef(0);
  const [state, setState] = useState<State>({ open: false, status: 'idle', count: 0 });
  useEffect(
    () => () => {
      request.current += 1;
    },
    [],
  );
  const prepare = useCallback(async () => {
    const current = ++request.current;
    setState({ open: true, status: 'loading', count: 0 });
    try {
      const count = readCount ? await readCount() : 0;
      if (!Number.isSafeInteger(count) || count < 0) throw new Error('Invalid comment count');
      if (current === request.current) setState({ open: true, status: 'ready', count });
    } catch {
      if (current === request.current) setState({ open: true, status: 'error', count: 0 });
    }
  }, [readCount]);
  const close = useCallback(() => {
    request.current += 1;
    setState({ open: false, status: 'idle', count: 0 });
  }, []);
  return { ...state, prepare, close };
}
