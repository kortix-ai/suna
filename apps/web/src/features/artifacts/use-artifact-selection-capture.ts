'use client';

import type { ArtifactCommentAnchor } from '@kortix/sdk';
import { useCallback, useRef, useState } from 'react';

export function useArtifactSelectionCapture() {
  const active = useRef<symbol | null>(null);
  const selected = useRef<ArtifactCommentAnchor | null>(null);
  const [state, setState] = useState<{
    status: 'idle' | 'pending' | 'failed';
    anchor: ArtifactCommentAnchor | null;
  }>({ status: 'idle', anchor: null });
  const begin = useCallback(() => {
    const request = Symbol();
    active.current = request;
    selected.current = null;
    setState({ status: 'pending', anchor: null });
    return () => {
      if (active.current !== request) return;
      active.current = null;
      setState({ status: 'failed', anchor: null });
    };
  }, []);
  const publish = useCallback((anchor: ArtifactCommentAnchor) => {
    if (!active.current) return false;
    active.current = null;
    selected.current = anchor;
    setState({ status: 'idle', anchor });
    return true;
  }, []);
  const clear = useCallback((expected?: ArtifactCommentAnchor) => {
    if (expected && (active.current || selected.current !== expected)) return;
    active.current = null;
    selected.current = null;
    setState({ status: 'idle', anchor: null });
  }, []);
  return { ...state, begin, publish, clear };
}
