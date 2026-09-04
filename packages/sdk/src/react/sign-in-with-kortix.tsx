'use client';

/**
 * Browser half of "Sign in with Kortix" — pairs with `createKortixAuth` from
 * `@kortix/sdk/server`, whose `handler()` serves `${basePath}/me` (the viewer)
 * and `${basePath}/signin` / `/signout` (the redirects).
 *
 * `useKortixViewer` reads `/me` once per mount and exposes the signed-in
 * viewer; `SignInWithKortix` is the link that starts sign-in. Both are
 * deliberately tiny — the session itself lives in an HttpOnly cookie the
 * browser never sees, so there is no token to manage here.
 */
import { createElement, useEffect, useState, type AnchorHTMLAttributes, type ReactNode } from 'react';
import { stripTrailingSlashes } from '../platform/strings';

export const KORTIX_AUTH_DEFAULT_BASE_PATH = '/api/kortix/auth';

/** The `/me` document `createKortixAuth().handler` serves. */
export interface KortixViewerInfo {
  user_id: string;
  email: string;
  accounts: Array<{ account_id: string; slug: string; name: string; role: string }>;
  scopes: string[];
  expires_at: string;
}

export type KortixViewerState =
  | { status: 'loading'; viewer: null }
  | { status: 'signed-out'; viewer: null }
  | { status: 'signed-in'; viewer: KortixViewerInfo }
  | { status: 'error'; viewer: null; error: string };

/** Pure fetch of `/me` — the hook's core, usable without React (tests, loaders). */
export async function fetchKortixViewer(
  basePath: string = KORTIX_AUTH_DEFAULT_BASE_PATH,
  fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> = (input, init) => fetch(input, init),
): Promise<KortixViewerState> {
  let res: Response;
  try {
    res = await fetchImpl(`${stripTrailingSlashes(basePath)}/me`, {
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    });
  } catch (err) {
    return { status: 'error', viewer: null, error: (err as Error).message };
  }
  if (res.status === 401) return { status: 'signed-out', viewer: null };
  if (!res.ok) return { status: 'error', viewer: null, error: `GET /me → ${res.status}` };
  const viewer = (await res.json()) as KortixViewerInfo;
  return { status: 'signed-in', viewer };
}

export function kortixSignInHref(basePath: string = KORTIX_AUTH_DEFAULT_BASE_PATH, returnTo?: string): string {
  const base = `${stripTrailingSlashes(basePath)}/signin`;
  return returnTo ? `${base}?return_to=${encodeURIComponent(returnTo)}` : base;
}

export function kortixSignOutHref(basePath: string = KORTIX_AUTH_DEFAULT_BASE_PATH, returnTo?: string): string {
  const base = `${stripTrailingSlashes(basePath)}/signout`;
  return returnTo ? `${base}?return_to=${encodeURIComponent(returnTo)}` : base;
}

/** The signed-in Kortix viewer of this app, read from `${basePath}/me`. */
export function useKortixViewer(options: { basePath?: string } = {}): KortixViewerState & { reload: () => void } {
  const basePath = options.basePath ?? KORTIX_AUTH_DEFAULT_BASE_PATH;
  const [state, setState] = useState<KortixViewerState>({ status: 'loading', viewer: null });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading', viewer: null });
    fetchKortixViewer(basePath).then((next) => {
      if (!cancelled) setState(next);
    });
    return () => {
      cancelled = true;
    };
  }, [basePath, tick]);
  return { ...state, reload: () => setTick((n) => n + 1) };
}

export interface SignInWithKortixProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> {
  basePath?: string;
  /** Same-origin path to land on after sign-in. Default: the current location. */
  returnTo?: string;
  children?: ReactNode;
}

/** An anchor that starts "Sign in with Kortix". Style it like any link or button. */
export function SignInWithKortix({ basePath, returnTo, children, ...rest }: SignInWithKortixProps) {
  const target =
    returnTo ?? (typeof window !== 'undefined' ? `${window.location.pathname}${window.location.search}` : undefined);
  return createElement('a', { ...rest, href: kortixSignInHref(basePath, target) }, children ?? 'Sign in with Kortix');
}
