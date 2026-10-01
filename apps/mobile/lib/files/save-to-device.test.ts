import { beforeEach, describe, expect, mock, test } from 'bun:test';

const files: string[] = [];
const copies: string[] = [];
const folders = new Map<string, { name: string; exists: boolean; files: string[] }>();
let picked = 0;
let failRemembered = false;

import { storage } from '../../stores/in-memory-async-storage';
mock.module('react-native', () => ({ Platform: { OS: 'android' } }));
mock.module('expo-file-system', () => ({
  Directory: class {
    uri: string;
    constructor(uri: string) { this.uri = uri; }
    static async pickDirectoryAsync() { picked++; return new this('new'); }
    get name() { return folders.get(this.uri)?.name ?? ''; }
    get exists() { return folders.get(this.uri)?.exists ?? false; }
    list() { return (folders.get(this.uri)?.files ?? []).map((name) => ({ name })); }
    createFile(name: string, _mime: string) {
      if (this.uri === 'old' && failRemembered) throw Error('permission revoked');
      files.push(`${this.uri}/${name}`);
      return { name, uri: `${this.uri}/${name}` };
    }
  },
  File: class {
    uri: string;
    constructor(uri: string) { this.uri = uri; }
    async copy(target: { uri: string }) { copies.push(`${this.uri} -> ${target.uri}`); }
  },
}));

const { saveFileToDevice } = await import('./save-to-device');

beforeEach(() => {
  files.length = 0;
  copies.length = 0;
  storage.clear();
  folders.clear();
  folders.set('new', { name: 'Downloads', exists: true, files: ['photo.png'] });
  picked = 0;
  failRemembered = false;
});

describe('saveFileToDevice', () => {
  test('creates a collision-free destination and copies cached file natively', async () => {
    expect(await saveFileToDevice('file:///cache/photo.png', 'photo.png')).toEqual({ status: 'saved', name: 'photo (1).png', folder: 'Downloads' });
    expect(files).toEqual(['new/photo (1).png']);
    expect(copies).toEqual(['file:///cache/photo.png -> new/photo (1).png']);
    expect(storage.get('files.download-folder-uri')).toBe('new');
  });

  test('forgets a revoked remembered folder and retries with a picked folder', async () => {
    folders.set('old', { name: 'Old', exists: true, files: [] });
    storage.set('files.download-folder-uri', 'old');
    failRemembered = true;
    expect(await saveFileToDevice('file:///cache/report.pdf', 'report.pdf')).toEqual({ status: 'saved', name: 'report.pdf', folder: 'Downloads' });
    expect(picked).toBe(1);
    expect(files).toEqual(['new/report.pdf']);
    expect(copies).toEqual(['file:///cache/report.pdf -> new/report.pdf']);
    expect(storage.get('files.download-folder-uri')).toBe('new');
  });
});
