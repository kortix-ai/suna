'use client';

/**
 * `useKortixAppViewer` — who is looking at this Kortix App.
 *
 * Inside a Kortix-hosted App the visitor is already signed in to Kortix, so
 * there is nothing to log in to: this hook reads the gate's answer and hands
 * the component the viewer. Pair with
 * `createKortix({ getToken: kortixAppViewerToken() })` for API calls made as
 * that viewer.
 */
import { useEffect, useState } from 'react';
import {
  fetchKortixAppViewer,
  type KortixAppViewerOptions,
  type KortixAppViewerSession,
} from '../core/auth/app-viewer';

export type KortixAppViewerState =
  | { status: 'loading'; viewer: null }
  | { status: 'anonymous'; viewer: null }
  | { status: 'viewer'; viewer: KortixAppViewerSession };

export function useKortixAppViewer(options: KortixAppViewerOptions = {}): KortixAppViewerState {
  const path = options.path;
  const [state, setState] = useState<KortixAppViewerState>({ status: 'loading', viewer: null });
  useEffect(() => {
    let cancelled = false;
    fetchKortixAppViewer({ path }).then((viewer) => {
      if (cancelled) return;
      setState(viewer ? { status: 'viewer', viewer } : { status: 'anonymous', viewer: null });
    });
    return () => {
      cancelled = true;
    };
  }, [path]);
  return state;
}
