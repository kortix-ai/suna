export type AccessMode = 'always' | 'ask' | 'off';
export type TabScope = 'own' | 'all';
export type ChromeConnection = {
  id: string; name: string; brand: string; os: string; profileLabel: string | null;
  extensionVersion: string | null; accessMode: AccessMode; tabScope: TabScope; online: boolean;
  lastSeenAt: string | null; createdAt: string;
  activeSessions: { sessionId: string; projectId: string; title: string }[];
};
export type AttachFrame = {
  type: 'attach'; attachmentId: string; sessionId: string; sessionTitle: string; projectId: string;
  projectName: string; bridgePath: string; ticket: string; consent: boolean;
};
/** Persisted in chrome.storage.session so a worker restart re-dials the bridge. */
export type AttachmentRecord = Omit<AttachFrame, 'type' | 'consent' | 'ticket'> & { groupId: number; tabIds?: number[] };
/** chrome.storage.local */
export type Stored = {
  apiUrl?: string; token?: string; refreshToken?: string; expiresAt?: number;
  clientId?: string; clientApi?: string; redirectUri?: string;
  chromeId?: string | null; chrome?: ChromeConnection; webUrl?: string;
};
/** Messages from pages and the overlay to the worker. */
export type PageMessage =
  | { kortix: 'status' }
  | { kortix: 'signin'; apiUrl?: string }
  | { kortix: 'oauth-done'; url: string }
  | { kortix: 'signout' }
  | { kortix: 'whoami' }
  | { kortix: 'panel-session' } // the side panel asks for a web session (see sidepanel.ts)
  | { kortix: 'disconnect' } // remove this browser from Kortix, then sign out
  | { kortix: 'patch'; body: { name?: string; accessMode?: AccessMode; tabScope?: TabScope } }
  | { kortix: 'stop'; attachmentId: string }
  | { kortix: 'add-tab'; attachmentId: string; tabId: number }
  | { kortix: 'act-tab'; sessionId: string; tabId: number } // a panel Act send: the session's attachment gets this tab
  | { kortix: 'consent-info'; attachmentId: string }
  | { kortix: 'consent'; attachmentId: string; decision: 'session' | 'project' | 'deny' }
  | { kortix: 'overlay-pause' } // from a tab; the worker finds the attachment
  | { kortix: 'overlay-stop' };
export type Status = {
  signedIn: boolean; online: boolean; apiUrl: string; webUrl: string; chrome?: ChromeConnection;
  attachments: { attachmentId: string; sessionId: string; projectId: string; title: string; paused: boolean }[];
};
export const DEFAULT_API_URL = 'https://api.kortix.com';
/** The Kortix web apps and the API each one signs in to. Only `kortix.com` is offered by name. */
export const SERVERS: { web: string; api: string }[] = [
  { web: 'kortix.com', api: 'https://api.kortix.com' },
  { web: 'dev.kortix.com', api: 'https://dev-api.kortix.com' },
  { web: 'staging.kortix.com', api: 'https://staging-api.kortix.com' },
];
export const BRAND_BLUE = '#0099ff'; // --kortix-base in tokens.css (badge color)
export const OFFLINE_GREY = '#666666'; // --muted-foreground in tokens.css (offline badge)
