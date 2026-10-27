import type { Status } from '../background/types';
import { rpc } from './rpc';

declare const __DEV_BUILD__: boolean | undefined;
/** True in `bun run build:dev` builds only. A store build offers kortix.com and nothing else. */
export const DEV_BUILD = typeof __DEV_BUILD__ !== 'undefined' && __DEV_BUILD__ === true;

export type Identity = { userId: string; email: string };

/** Sign-in lives on the welcome page: it is the one place to pick the server. */
export const openWelcome = () => chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') });
export const openInTab = (url: string) => void chrome.tabs.create({ url });

/** Mark the button whose data-v equals `value` as the checked radio. */
export function markSegment(seg: HTMLElement, value: string | undefined) {
  const buttons = [...seg.querySelectorAll('button')];
  const on = buttons.some((b) => b.dataset.v === value);
  buttons.forEach((b, i) => {
    const checked = b.dataset.v === value;
    b.setAttribute('aria-checked', String(checked));
    b.tabIndex = checked || (!on && i === 0) ? 0 : -1;
  });
}

/** Index after an arrow key in a radio group of `n`, or undefined for any other key. */
export function arrowTarget(key: string, i: number, n: number): number | undefined {
  const step = ({ ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 } as Record<string, number>)[key];
  return step === undefined ? undefined : (Math.max(i, 0) + step + n) % n;
}

/** Make `seg` an accessible radiogroup: roles, a name, roving tabindex, arrow keys. `pick` gets data-v. */
export function segmented(seg: HTMLElement, label: string, pick: (value: string) => void) {
  seg.setAttribute('role', 'radiogroup');
  seg.setAttribute('aria-label', label);
  const buttons = () => [...seg.querySelectorAll('button')];
  buttons().forEach((b) => b.setAttribute('role', 'radio'));
  markSegment(seg, undefined);
  seg.onclick = (e) => {
    const v = (e.target as HTMLElement).closest('button')?.dataset.v;
    if (v) pick(v);
  };
  seg.onkeydown = (e) => {
    const list = buttons();
    const to = arrowTarget(e.key, list.indexOf(document.activeElement as HTMLButtonElement), list.length);
    if (to === undefined) return;
    e.preventDefault();
    list[to].focus();
    if (list[to].dataset.v) pick(list[to].dataset.v);
  };
}

/** Update `parent`'s children to match `items` without rebuilding rows that did not change (keeps focus). */
export function reconcile<T>(parent: HTMLElement, items: T[], key: (t: T) => string, make: (t: T) => HTMLElement, update: (el: HTMLElement, t: T) => void) {
  const have = new Map([...parent.children].map((el) => [(el as HTMLElement).dataset.key!, el as HTMLElement]));
  const keep = new Set<string>();
  items.forEach((t, i) => {
    const k = key(t);
    keep.add(k);
    let el = have.get(k);
    if (!el) { el = make(t); el.dataset.key = k; }
    update(el, t);
    if (parent.children[i] !== el) parent.insertBefore(el, parent.children[i] ?? null);
  });
  for (const [k, el] of have) if (!keep.has(k)) el.remove();
}

export const getStatus = () => rpc<Status>({ kortix: 'status' });

/** The account the extension is signed in as. */
export const whoami = () => rpc<Identity>({ kortix: 'whoami' });

/** Two identities differ when both are known and the user ids disagree. */
export const accountsDiffer = (a: Identity | undefined, b: Identity | undefined) =>
  !!a?.userId && !!b?.userId && a.userId !== b.userId;

export type FrameMessage = { origin: string; source: unknown; data: unknown };
/** True for a message the panel's own frame sent from the web app's origin. */
export const fromPanelFrame = (e: FrameMessage, webUrl: string, frame: Window | null) => {
  try { return !!frame && e.source === frame && e.origin === new URL(webUrl).origin; } catch { return false; }
};

/** A `kortix.identity` message counts only from the web app's own origin, sent by the panel's frame. */
export function identityFrom(e: FrameMessage, webUrl: string, frame: Window | null): Identity | undefined {
  const d = e.data as { type?: string; userId?: unknown; email?: unknown } | null;
  if (!fromPanelFrame(e, webUrl, frame) || d?.type !== 'kortix.identity') return undefined;
  if (typeof d.userId !== 'string') return undefined;
  return { userId: d.userId, email: typeof d.email === 'string' ? d.email : '' };
}

/** `kortix.panel.needSession` counts only from the web app's origin, sent by the panel's frame. */
export const needsSession = (e: FrameMessage, webUrl: string, frame: Window | null) =>
  fromPanelFrame(e, webUrl, frame) && (e.data as { type?: unknown } | null)?.type === 'kortix.panel.needSession';

/**
 * Answers the panel page's `needSession` with a session hash (panel sign-in contract).
 * One request at a time, at most two per navigation (the request and one retry). The hash is a credential: never logged.
 */
export class PanelHandoff {
  private attempts = 0;
  private busy = false;
  constructor(private request: () => Promise<string>, private deliver: (tokenHash: string) => void) {}
  /** The extension navigated the frame itself: allow a fresh attempt. */
  reset() { this.attempts = 0; }
  async onNeedSession() {
    if (this.busy || this.attempts >= 2) return;
    this.busy = true;
    this.attempts++;
    try { this.deliver(await this.request()); } catch { /* the web page shows its own "Sign in" link */ } finally { this.busy = false; }
  }
}
