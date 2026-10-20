'use client';

import { useEffect, useState } from 'react';

import type { UiPreviewRequest, UiPreviewUrlResolver } from '../providers/ui-provider';

export interface HostPreviewUrl {
  /** False: no resolver, or it returned null. The caller uses the SDK default. */
  handled: boolean;
  /** The URL to frame. Null while the resolver runs, or after it failed. */
  url: string | null;
  failed: boolean;
}

const DEFAULT: HostPreviewUrl = { handled: false, url: null, failed: false };
const PENDING: HostPreviewUrl = { handled: true, url: null, failed: false };

/**
 * The host's URL for one preview request (`UiProvider resolvePreviewUrl`).
 * The request is re-resolved when any of its fields change. Pure in its
 * inputs, so the panel and its tests share it.
 */
export function useHostPreviewUrl(
  resolve: UiPreviewUrlResolver | undefined,
  request: UiPreviewRequest | null,
): HostPreviewUrl {
  const key = resolve && request ? JSON.stringify(request) : '';
  const [state, setState] = useState<{ key: string; value: HostPreviewUrl }>({ key: '', value: DEFAULT });

  useEffect(() => {
    if (!key || !resolve) return;
    let cancelled = false;
    setState({ key, value: PENDING });
    resolve(JSON.parse(key) as UiPreviewRequest).then(
      (url) => {
        if (!cancelled) setState({ key, value: url === null ? DEFAULT : { handled: true, url, failed: false } });
      },
      () => {
        if (!cancelled) setState({ key, value: { handled: true, url: null, failed: true } });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [key, resolve]);

  if (!key) return DEFAULT;
  return state.key === key ? state.value : PENDING;
}
