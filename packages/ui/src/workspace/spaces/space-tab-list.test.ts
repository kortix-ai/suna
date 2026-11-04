import { describe, expect, test } from 'bun:test';
import type { ProjectSpaceTab } from '@kortix/sdk';

import {
  CHAT_TAB,
  filePathPrefix,
  folderTitle,
  isHtmlPath,
  isLinkUrl,
  moveTab,
  newTabId,
  normalizeFolderPath,
  openTabId,
  removeTab,
  renameTab,
  tabTitle,
} from './space-tab-list';

const TABS: ProjectSpaceTab[] = [
  { id: 'threads-a', title: 'Page', kind: 'file', ref: '/Company/Channels/eng/page.html' },
  { id: 'link-b', title: 'Docs', kind: 'link', ref: 'https://example.test' },
  { id: 'memory-c', title: 'Specs', kind: 'folder', ref: '/Company/Channels/eng' },
];
const ids = (tabs: ProjectSpaceTab[]) => tabs.map((tab) => tab.id);

describe('openTabId', () => {
  test('a stored id opens that tab; an old fixed tab name, an unknown id or none opens Chat', () => {
    expect(openTabId(TABS, 'link-b')).toBe('link-b');
    expect(openTabId(TABS, 'files')).toBe(CHAT_TAB);
    expect(openTabId(TABS, null)).toBe(CHAT_TAB);
    expect(openTabId([], 'threads-a')).toBe(CHAT_TAB);
  });
});

describe('moveTab', () => {
  test('moves one place left or right and stays at an end', () => {
    expect(ids(moveTab(TABS, 'link-b', -1))).toEqual(['link-b', 'threads-a', 'memory-c']);
    expect(ids(moveTab(TABS, 'link-b', 1))).toEqual(['threads-a', 'memory-c', 'link-b']);
    expect(ids(moveTab(TABS, 'threads-a', -1))).toEqual(ids(TABS));
    expect(ids(moveTab(TABS, 'memory-c', 1))).toEqual(ids(TABS));
  });
});

describe('rename and remove', () => {
  test('rename trims to one line of at most 60 characters and keeps the old title when blank', () => {
    expect(renameTab(TABS, 'link-b', '  Team\n docs ')[1]!.title).toBe('Team docs');
    expect(renameTab(TABS, 'link-b', '   ')[1]!.title).toBe('Docs');
    expect(tabTitle('x'.repeat(80), 'X')).toHaveLength(60);
  });

  test('remove drops only that tab', () => {
    expect(ids(removeTab(TABS, 'link-b'))).toEqual(['threads-a', 'memory-c']);
  });
});

describe('new tabs', () => {
  test('a new id is the kind plus 6 characters, never one already taken', () => {
    const values = [0, 0, 0.5];
    const id = newTabId('file', [{ id: 'file-000000', title: 'T', kind: 'file', ref: '/a.md' }], () => values.shift()!);
    expect(id).toMatch(/^file-[0-9a-z]{6}$/);
    expect(id).not.toBe('file-000000');
  });

  test('folder paths take one leading slash; links must be https', () => {
    expect(normalizeFolderPath(' Company/Channels/eng/ ')).toBe('/Company/Channels/eng');
    expect(normalizeFolderPath('/')).toBe('');
    expect(isLinkUrl('https://example.test/a')).toBe(true);
    expect(isLinkUrl('http://example.test')).toBe(false);
  });
});

describe('file tabs', () => {
  test('.html and .htm render as a page; every other file uses the file viewer', () => {
    expect(isHtmlPath('/Company/Channels/eng/news.html')).toBe(true);
    expect(isHtmlPath('/a/B.HTM')).toBe(true);
    expect(isHtmlPath('/a/notes.md')).toBe(false);
    expect(isHtmlPath('/a/html')).toBe(false);
  });

  test('a new file path starts in the space folder; the title is the file name', () => {
    expect(filePathPrefix('/Company/Channels/eng')).toBe('/Company/Channels/eng/');
    expect(filePathPrefix(null)).toBe('/');
    expect(folderTitle('/Company/Channels/eng/launch.html')).toBe('launch.html');
  });
});
