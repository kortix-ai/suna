// The side panel's page channel (protocol.md §11). The Kortix page in the panel asks for the
// active tab, the open tabs and their text. It never reads a tab itself, and the extension
// answers only the panel's own frame.
import { fromPanelFrame, type FrameMessage } from './common';

export type PanelTab = { id: number; title: string; url: string; favIconUrl?: string; readable: boolean };
export type PanelPage =
  | { tabId: number; title: string; url: string; text: string; truncated: boolean }
  | { tabId: number; error: 'unreadable' };
/** A right-click on "Ask Kortix": the tab, and the selected text when there was one. */
export type PanelContext = { tabId: number; quote?: string; at: number };

export type PanelRequest =
  | { type: 'kortix.panel.hello' }
  | { type: 'kortix.panel.tabs'; requestId: string }
  | { type: 'kortix.panel.read'; requestId: string; tabIds: number[] }
  | { type: 'kortix.panel.capture'; requestId: string }
  | { type: 'kortix.panel.act'; tabId: number }
  | { type: 'kortix.panel.route'; path: string; sessionId?: string };

/** A longer page is cut here, and the result says so. */
export const MAX_PAGE_CHARS = 100_000;
export const MAX_READ_TABS = 8;
export const MAX_QUOTE_CHARS = 4_000;
/** A screenshot is a JPEG of the visible part of the tab: a few hundred KB, enough for a model to read. */
export const CAPTURE_QUALITY = 80;
/** An Act send hands its tab to the session the panel opens within this time. */
export const ACT_HANDOFF_MS = 5 * 60_000;

const isTabId = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0;
const isId = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;

/** A request from the panel's frame, or undefined for anything else. */
export function panelRequest(e: FrameMessage, webUrl: string, frame: Window | null): PanelRequest | undefined {
  if (!fromPanelFrame(e, webUrl, frame)) return undefined;
  const d = e.data as Record<string, unknown> | null;
  switch (d?.type) {
    case 'kortix.panel.hello': return { type: d.type };
    case 'kortix.panel.tabs': return isId(d.requestId, 64) ? { type: d.type, requestId: d.requestId } : undefined;
    case 'kortix.panel.read': {
      const ids = d.tabIds;
      if (!isId(d.requestId, 64) || !Array.isArray(ids) || !ids.length || ids.length > MAX_READ_TABS || !ids.every(isTabId)) return undefined;
      return { type: d.type, requestId: d.requestId, tabIds: [...new Set(ids)] };
    }
    case 'kortix.panel.capture': return isId(d.requestId, 64) ? { type: d.type, requestId: d.requestId } : undefined;
    case 'kortix.panel.act': return isTabId(d.tabId) ? { type: d.type, tabId: d.tabId } : undefined;
    case 'kortix.panel.route':
      if (!isId(d.path, 2048) || !d.path.startsWith('/')) return undefined;
      return { type: d.type, path: d.path, ...(isId(d.sessionId, 128) ? { sessionId: d.sessionId } : {}) };
  }
  return undefined;
}

// Chrome refuses scripts on its own pages and on the Web Store.
const STORE = /^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)(\/|$)/;
export const isReadableUrl = (url: string) => /^https?:\/\//.test(url) && !STORE.test(url);

export function toPanelTab(t: chrome.tabs.Tab): PanelTab | undefined {
  if (!isTabId(t.id) || !t.url) return undefined;
  return { id: t.id, title: t.title || t.url, url: t.url, ...(t.favIconUrl ? { favIconUrl: t.favIconUrl } : {}), readable: isReadableUrl(t.url) };
}

/**
 * The tab the panel is about: the window's active tab. When the panel is itself that tab
 * (sidepanel.html opened as a page), the tab used last before it.
 */
export function contextTab<T extends { id?: number; active: boolean; lastAccessed?: number }>(tabs: T[], selfId?: number): T | undefined {
  const active = tabs.find((t) => t.active);
  if (active && active.id !== selfId) return active;
  return tabs.filter((t) => t.id !== selfId).sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0];
}

/** Runs in the page (chrome.scripting): self-contained, no imports. */
export function readPage(max: number) {
  const text = (document.body?.innerText ?? '').replace(/\n{3,}/g, '\n\n').trim();
  return { title: document.title, url: location.href, text: text.slice(0, max), truncated: text.length > max };
}

/** The tab an Act send handed over, while it is still fresh. */
export const freshAct = (act: { tabId: number; at: number } | undefined, now: number) =>
  act && now - act.at < ACT_HANDOFF_MS ? act.tabId : undefined;
