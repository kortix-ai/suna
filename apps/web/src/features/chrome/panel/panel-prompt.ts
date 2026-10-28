import type { AttachedFile } from '@kortix/ui/composer';

import type { PanelPage, PanelTab } from './panel-channel';

export type PanelMode = 'read' | 'act';
export type ReadPage = Extract<PanelPage, { text: string }>;

export const isReadPage = (page: PanelPage): page is ReadPage => 'text' in page;

const FILE_NAME_MAX = 80;

/** A file name from a page title: no path or reserved characters, at most 80 characters. */
export function pageFileName(title: string): string {
  const base = title.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, FILE_NAME_MAX).trim();
  return `${base || 'page'}.md`;
}

/** The page as Markdown: title, address, when it was read, then the text. */
export function pageMarkdown(page: ReadPage, readAt: Date): string {
  const note = page.truncated ? ' The page is longer: this is its first part.' : '';
  return `# ${page.title || page.url}\n\nSource: ${page.url}\nRead from the person's Chrome tab at ${readAt.toISOString()}.${note}\n\n---\n\n${page.text}\n`;
}

/** A read page as a composer attachment: it uploads like a file the person picked. */
export function pageAttachment(page: ReadPage, readAt: Date): AttachedFile {
  const file = new File([pageMarkdown(page, readAt)], pageFileName(page.title), { type: 'text/markdown' });
  return { kind: 'local', file, localUrl: '', isImage: false, attachedAt: readAt.getTime() };
}

const JPEG_DATA_URL = 'data:image/jpeg;base64,';

/** The extension's screenshot (a JPEG data URL) as an image attachment named after the page. */
export function screenshotAttachment(dataUrl: string, title: string, takenAt: Date): AttachedFile {
  if (!dataUrl.startsWith(JPEG_DATA_URL)) throw new Error('Not a JPEG screenshot');
  const binary = atob(dataUrl.slice(JPEG_DATA_URL.length));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const name = `${pageFileName(title).slice(0, -'.md'.length)} screenshot.jpg`;
  const file = new File([bytes], name, { type: 'image/jpeg' });
  return { kind: 'local', file, localUrl: '', isImage: true, attachedAt: takenAt.getTime() };
}

/** The selected text under the person's message, with where it came from. */
export function withQuote(text: string, quote: string, tab: PanelTab | null): string {
  const source = tab ? ` from “${tab.title}” (${tab.url})` : '';
  const lines = quote.split('\n').map((line) => `> ${line}`).join('\n');
  return `${text}\n\nSelected text${source}:\n${lines}`;
}

/**
 * Act: the agent drives this tab. The extension adds it to the session's Kortix
 * tab group when the session attaches. The agent reads this line in English,
 * whatever the person's language.
 */
export function withActTab(text: string, tab: PanelTab): string {
  return `${text}\n\nUse my Chrome for this. Start in my open tab “${tab.title}” (${tab.url}).`;
}

/** The tabs a send carries: the followed active tab first, then the added ones, once each. */
export function sendTabs(active: PanelTab | null, follow: boolean, added: readonly PanelTab[]): PanelTab[] {
  const tabs = follow && active ? [active, ...added] : [...added];
  return tabs.filter((tab, index) => tabs.findIndex((other) => other.id === tab.id) === index);
}
