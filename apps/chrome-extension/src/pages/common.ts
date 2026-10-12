import type { Status } from '../background/types';
import { rpc } from './rpc';

export type Identity = { userId: string; email: string };

/** Sign-in lives on the welcome page: it is the one place to pick the server. */
export const openWelcome = () => chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') });
export const openInTab = (url: string) => void chrome.tabs.create({ url });

/** Mark the button whose data-v equals `value` as pressed. */
export function markSegment(seg: HTMLElement, value: string | undefined) {
  seg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === value)));
}

export const getStatus = () => rpc<Status>({ kortix: 'status' });

/** The account the extension is signed in as. */
export const whoami = () => rpc<Identity>({ kortix: 'whoami' });

/** Two identities differ when both are known and the user ids disagree. */
export const accountsDiffer = (a: Identity | undefined, b: Identity | undefined) =>
  !!a?.userId && !!b?.userId && a.userId !== b.userId;

/** A `kortix.identity` message counts only from the web app's own origin, sent by the panel's frame. */
export function identityFrom(e: { origin: string; source: unknown; data: unknown }, webUrl: string, frame: Window | null): Identity | undefined {
  const d = e.data as { type?: string; userId?: unknown; email?: unknown } | null;
  if (e.origin !== new URL(webUrl).origin || e.source !== frame || d?.type !== 'kortix.identity') return undefined;
  if (typeof d.userId !== 'string') return undefined;
  return { userId: d.userId, email: typeof d.email === 'string' ? d.email : '' };
}
