// Kortix for Chrome: the Chrome extension that connects a person's own browser to
// Kortix. These calls manage the browsers the caller connected. A session
// attaches to one through the sandbox routes, which are not part of this SDK.

import { backendApi } from '../../http/api-client';
import { unwrap } from './shared';

/** When a session may use the browser. `always`: without asking. `ask`: the extension prompts each session. `off`: refused. */
export type ChromeAccessMode = 'always' | 'ask' | 'off';
/** Which tabs a session reaches. `own`: tabs the session opened. `all`: every web tab. */
export type ChromeTabScope = 'own' | 'all';

export interface ChromeConnectionSession {
  sessionId: string;
  projectId: string;
  title: string | null;
}

export interface ChromeConnection {
  id: string;
  name: string;
  /** `Chrome`, `Edge`, `Brave`, `Arc`, ... */
  brand: string;
  os: string;
  profileLabel: string | null;
  extensionVersion: string | null;
  accessMode: ChromeAccessMode;
  tabScope: ChromeTabScope;
  /** The extension's control socket answered in the last 75 s. */
  online: boolean;
  lastSeenAt: string | null;
  createdAt: string;
  /** Sessions that drive the browser now. */
  activeSessions: ChromeConnectionSession[];
}

export interface ChromeConnectionUpdate {
  name?: string;
  accessMode?: ChromeAccessMode;
  tabScope?: ChromeTabScope;
}

const chromePath = (id: string) => `/chrome/connections/${encodeURIComponent(id)}`;

/** The browsers the caller connected, newest `lastSeenAt` first. */
export async function listChromeConnections(): Promise<ChromeConnection[]> {
  return unwrap(await backendApi.get<ChromeConnection[]>('/chrome/connections'), 'Failed to load browsers');
}

/** Rename a browser or change its access mode or tab scope. The extension sees the change at once. */
export async function updateChromeConnection(id: string, update: ChromeConnectionUpdate): Promise<ChromeConnection> {
  return unwrap(await backendApi.patch<ChromeConnection>(chromePath(id), update), 'Failed to update the browser');
}

/** Disconnect a browser from Kortix and end its active sessions. */
export async function deleteChromeConnection(id: string): Promise<void> {
  const res = await backendApi.delete(chromePath(id));
  if (!res.success) throw res.error ?? new Error('Failed to disconnect the browser');
}
