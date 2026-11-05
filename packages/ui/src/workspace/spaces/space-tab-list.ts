import type { ProjectSpaceTab, ProjectSpaceTabKind } from '@kortix/sdk';

/**
 * A space's tabs: Chat (always first, never stored) and the space's stored
 * list (`space.tabs`), which the tab row edits by replacing it whole
 * (`PUT /spaces/:spaceId/tabs`). These are the pure steps of that edit.
 */

/** The `?tab=` value of Chat: the param is absent. */
export const CHAT_TAB = 'chat';
/** Same as the API's `SPACE_TABS_MAX`. */
export const SPACE_TABS_MAX = 20;
export const SPACE_TAB_TITLE_MAX = 60;

/** The open tab: a stored tab's id when `?tab=` names one, else Chat. */
export function openTabId(tabs: readonly ProjectSpaceTab[], param: string | null): string {
  return param && tabs.some((tab) => tab.id === param) ? param : CHAT_TAB;
}

/** A new tab id: the kind, then 6 random characters. Unique within `taken`. */
export function newTabId(kind: ProjectSpaceTabKind, taken: readonly ProjectSpaceTab[], random: () => number = Math.random): string {
  for (;;) {
    const id = `${kind}-${Math.floor(random() * 36 ** 6)
      .toString(36)
      .padStart(6, '0')}`;
    if (!taken.some((tab) => tab.id === id) && id !== CHAT_TAB) return id;
  }
}

/** A title the API accepts: one line, trimmed, at most 60 characters. */
export function tabTitle(text: string, fallback: string): string {
  const flat = text.replace(/\s+/g, ' ').trim() || fallback;
  return flat.length > SPACE_TAB_TITLE_MAX ? `${flat.slice(0, SPACE_TAB_TITLE_MAX - 1)}…` : flat;
}

/** The last segment of a Drive file or folder path, else the path. */
export function folderTitle(path: string): string {
  return path.split('/').filter(Boolean).at(-1) ?? path;
}

/** The host of an https URL, else the URL. */
export function linkTitle(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/** A Drive file or folder path as stored: one leading slash, no trailing slash. */
export function normalizeFolderPath(path: string): string {
  const inner = path.trim().replace(/^\/+|\/+$/g, '');
  return inner ? `/${inner}` : '';
}

/** A file tab shows the file as a page in a sandboxed frame: `.html` and `.htm`. */
export function isHtmlPath(path: string): boolean {
  return /\.html?$/i.test(path.trim());
}

/**
 * Where a "File…" path starts: the space's own files folder plus a slash, so
 * a person types only the file name. `/` when the space has no folder.
 */
export function filePathPrefix(folder: string | null): string {
  return folder ? `${folder.replace(/\/+$/, '')}/` : '/';
}

/** Whether the text is a URL a link tab may store. */
export function isLinkUrl(text: string): boolean {
  return /^https:\/\/[^\s]+$/i.test(text.trim());
}

export function appendTab(tabs: readonly ProjectSpaceTab[], tab: ProjectSpaceTab): ProjectSpaceTab[] {
  return [...tabs, tab];
}

export function renameTab(tabs: readonly ProjectSpaceTab[], id: string, title: string): ProjectSpaceTab[] {
  return tabs.map((tab) => (tab.id === id ? { ...tab, title: tabTitle(title, tab.title) } : tab));
}

export function removeTab(tabs: readonly ProjectSpaceTab[], id: string): ProjectSpaceTab[] {
  return tabs.filter((tab) => tab.id !== id);
}

/** Move a tab one place left (-1) or right (+1). At an end it stays. Chat never moves. */
export function moveTab(tabs: readonly ProjectSpaceTab[], id: string, by: -1 | 1): ProjectSpaceTab[] {
  const from = tabs.findIndex((tab) => tab.id === id);
  const to = from + by;
  if (from < 0 || to < 0 || to >= tabs.length) return [...tabs];
  const next = [...tabs];
  const [tab] = next.splice(from, 1);
  next.splice(to, 0, tab!);
  return next;
}
