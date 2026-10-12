// Kortix Browser: the Chrome extension that connects a person's own browser to
// Kortix. These calls manage the browsers the caller connected. A session
// attaches to one through the sandbox routes, which are not part of this SDK.

import { backendApi } from '../../http/api-client';
import { unwrap } from './shared';

/** When a session may use the browser. `always`: without asking. `ask`: the extension prompts each session. `off`: refused. */
export type BrowserAccessMode = 'always' | 'ask' | 'off';
/** Which tabs a session reaches. `own`: tabs the session opened. `all`: every web tab. */
export type BrowserTabScope = 'own' | 'all';

export interface KortixBrowserSession {
  sessionId: string;
  projectId: string;
  title: string | null;
}

export interface KortixBrowser {
  id: string;
  name: string;
  /** `Chrome`, `Edge`, `Brave`, `Arc`, ... */
  brand: string;
  os: string;
  profileLabel: string | null;
  extensionVersion: string | null;
  accessMode: BrowserAccessMode;
  tabScope: BrowserTabScope;
  /** The extension's control socket answered in the last 75 s. */
  online: boolean;
  lastSeenAt: string | null;
  createdAt: string;
  /** Sessions that drive the browser now. */
  activeSessions: KortixBrowserSession[];
}

export interface KortixBrowserUpdate {
  name?: string;
  accessMode?: BrowserAccessMode;
  tabScope?: BrowserTabScope;
}

const browserPath = (id: string) => `/browsers/${encodeURIComponent(id)}`;

/** The browsers the caller connected, newest `lastSeenAt` first. */
export async function listBrowsers(): Promise<KortixBrowser[]> {
  return unwrap(await backendApi.get<KortixBrowser[]>('/browsers'), 'Failed to load browsers');
}

/** Rename a browser or change its access mode or tab scope. The extension sees the change at once. */
export async function updateBrowser(id: string, update: KortixBrowserUpdate): Promise<KortixBrowser> {
  return unwrap(await backendApi.patch<KortixBrowser>(browserPath(id), update), 'Failed to update the browser');
}

/** Disconnect a browser from Kortix and end its active sessions. */
export async function deleteBrowser(id: string): Promise<void> {
  const res = await backendApi.delete(browserPath(id));
  if (!res.success) throw res.error ?? new Error('Failed to disconnect the browser');
}
