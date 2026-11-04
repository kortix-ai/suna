'use client';

/**
 * The web half of the Kortix in Chrome side panel's page channel
 * (`.agents/skills/kortix-chrome/references/protocol.md` §11). The extension
 * frames `/panel`. This page asks it for the active tab, the open tabs and a
 * tab's text; the extension reads a tab only when this page asks, and this
 * page asks only when the person presses Send.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { EXTENSION_ORIGIN, isInExtensionPanel } from '@/lib/supabase/panel-cookies';

export interface PanelTab {
  id: number;
  title: string;
  url: string;
  /** False for Chrome's own pages and the Web Store: Chrome lets no extension read them. */
  readable: boolean;
}

export type PanelPage =
  | { tabId: number; title: string; url: string; text: string; truncated: boolean }
  | { tabId: number; error: 'unreadable' };

/** A right-click on "Ask Kortix": the tab, and the selected text when there was one. */
export interface PanelContext {
  tab: PanelTab | null;
  quote?: string;
}

export type ExtensionMessage =
  | { type: 'kortix.panel.tab'; tab: PanelTab | null }
  | { type: 'kortix.panel.context'; tab: PanelTab | null; quote?: string }
  | { type: 'kortix.panel.tabs.result'; requestId: string; tabs: PanelTab[] }
  | { type: 'kortix.panel.read.result'; requestId: string; pages: PanelPage[] }
  /** No `dataUrl`: Chrome refused the capture (its own pages, a minimized window). */
  | { type: 'kortix.panel.capture.result'; requestId: string; dataUrl?: string };

/** A JPEG of one visible tab; anything larger is not a screenshot the extension took. */
const MAX_SCREENSHOT_DATA_URL = 20_000_000;

/** The extension answers in well under a second; a read of several long pages takes longer. */
const REQUEST_TIMEOUT_MS = 15_000;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const isString = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;
const isTabId = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0;

function readTab(v: unknown): PanelTab | null {
  if (!isRecord(v) || !isTabId(v.id) || !isString(v.title, 2_000) || !isString(v.url, 8_192)) return null;
  return { id: v.id, title: v.title, url: v.url, readable: v.readable === true };
}

function readPage(v: unknown): PanelPage | null {
  if (!isRecord(v) || !isTabId(v.tabId)) return null;
  if (v.error === 'unreadable') return { tabId: v.tabId, error: 'unreadable' };
  if (!isString(v.title, 2_000) || !isString(v.url, 8_192) || !isString(v.text, 200_000)) return null;
  return { tabId: v.tabId, title: v.title, url: v.url, text: v.text, truncated: v.truncated === true };
}

/**
 * A message from the extension, or null. Only the framing extension page
 * counts: any other origin or window is ignored, and every field is checked.
 */
export function readExtensionMessage(
  event: { origin: string; source: unknown; data: unknown },
  parent: unknown,
): ExtensionMessage | null {
  if (event.origin !== EXTENSION_ORIGIN || event.source !== parent || !isRecord(event.data)) return null;
  const d = event.data;
  switch (d.type) {
    case 'kortix.panel.tab':
      return { type: d.type, tab: readTab(d.tab) };
    case 'kortix.panel.context': {
      const quote = isString(d.quote, 4_000) && d.quote.trim() ? d.quote.trim() : undefined;
      return { type: d.type, tab: readTab(d.tab), ...(quote ? { quote } : {}) };
    }
    case 'kortix.panel.tabs.result':
      if (!isString(d.requestId, 64) || !Array.isArray(d.tabs)) return null;
      return { type: d.type, requestId: d.requestId, tabs: d.tabs.map(readTab).filter((t): t is PanelTab => t !== null) };
    case 'kortix.panel.capture.result': {
      if (!isString(d.requestId, 64)) return null;
      const ok = isString(d.dataUrl, MAX_SCREENSHOT_DATA_URL) && d.dataUrl.startsWith('data:image/jpeg;base64,');
      return { type: d.type, requestId: d.requestId, ...(ok ? { dataUrl: d.dataUrl as string } : {}) };
    }
    case 'kortix.panel.read.result':
      if (!isString(d.requestId, 64) || !Array.isArray(d.pages)) return null;
      return {
        type: d.type,
        requestId: d.requestId,
        pages: d.pages.map(readPage).filter((p): p is PanelPage => p !== null),
      };
  }
  return null;
}

/** The session a panel path shows, for the extension's Act hand-off. */
export function sessionIdFromPath(pathname: string): string | undefined {
  return /\/projects\/[^/]+\/sessions\/([^/?#]+)/.exec(pathname)?.[1];
}

function post(message: Record<string, unknown>) {
  // The target origin is the extension: no other page frames the panel.
  window.parent.postMessage(message, EXTENSION_ORIGIN);
}

/** Whether this document is the side panel never changes while it is open. */
const noSubscription = () => () => {};

/** Tells the extension which page the panel shows. One caller: the app shell. */
export function postPanelRoute(pathname: string) {
  const sessionId = sessionIdFromPath(pathname);
  post({ type: 'kortix.panel.route', path: pathname, ...(sessionId ? { sessionId } : {}) });
}

/**
 * The page channel for `/panel`: the active tab (live), right-click contexts,
 * and the requests Send makes. Outside the side panel, `inPanel` is false and
 * nothing is sent.
 */
export function usePanelChannel(onContext: (context: PanelContext) => void) {
  // False on the server and on the first client render, so hydration matches.
  const inPanel = useSyncExternalStore(noSubscription, isInExtensionPanel, () => false);
  const [activeTab, setActiveTab] = useState<PanelTab | null>(null);
  const waiting = useRef(new Map<string, (message: ExtensionMessage) => void>());
  const contextRef = useRef(onContext);
  useEffect(() => {
    contextRef.current = onContext;
  });

  useEffect(() => {
    if (!inPanel) return;
    const onMessage = (event: MessageEvent) => {
      const message = readExtensionMessage(event, window.parent);
      if (!message) return;
      if (message.type === 'kortix.panel.tab') setActiveTab(message.tab);
      else if (message.type === 'kortix.panel.context') contextRef.current({ tab: message.tab, quote: message.quote });
      else waiting.current.get(message.requestId)?.(message);
    };
    window.addEventListener('message', onMessage);
    post({ type: 'kortix.panel.hello' });
    return () => window.removeEventListener('message', onMessage);
  }, [inPanel]);

  const ask = useCallback(<T extends ExtensionMessage>(message: Record<string, unknown>): Promise<T> => {
    const requestId = crypto.randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        waiting.current.delete(requestId);
        reject(new Error('The extension did not answer.'));
      }, REQUEST_TIMEOUT_MS);
      waiting.current.set(requestId, (answer) => {
        window.clearTimeout(timer);
        waiting.current.delete(requestId);
        resolve(answer as T);
      });
      post({ ...message, requestId });
    });
  }, []);

  const listTabs = useCallback(
    async () =>
      (await ask<Extract<ExtensionMessage, { type: 'kortix.panel.tabs.result' }>>({ type: 'kortix.panel.tabs' })).tabs,
    [ask],
  );
  const readTabs = useCallback(
    async (tabIds: number[]) =>
      (await ask<Extract<ExtensionMessage, { type: 'kortix.panel.read.result' }>>({ type: 'kortix.panel.read', tabIds }))
        .pages,
    [ask],
  );
  /** A JPEG of the panel window's visible tab, or undefined when Chrome refused. */
  const capture = useCallback(
    async () =>
      (await ask<Extract<ExtensionMessage, { type: 'kortix.panel.capture.result' }>>({ type: 'kortix.panel.capture' }))
        .dataUrl,
    [ask],
  );
  /** Act: the next session this panel opens gets this tab in its Kortix tab group. */
  const handAct = useCallback((tabId: number) => post({ type: 'kortix.panel.act', tabId }), []);

  return { inPanel, activeTab, listTabs, readTabs, capture, handAct };
}
