import { describe, expect, test } from 'bun:test';

import { drivePathFromParam, drivePathToParam, driveUrlWithPath } from './drive-path-param';

const ME = '/Users/ana';

describe('Drive ?path= value', () => {
  test('the own folder is ~, and round-trips', () => {
    expect(drivePathToParam('Users/ana/Memory/2026', ME)).toBe('~/Memory/2026');
    expect(drivePathToParam('Users/ana', ME)).toBe('~');
    expect(drivePathFromParam('~/Memory/2026', ME)).toBe('Users/ana/Memory/2026');
    expect(drivePathFromParam('~', ME)).toBe('Users/ana');
  });

  test('another person whose name starts the same is not ~', () => {
    expect(drivePathToParam('Users/anabel/x', ME)).toBe('Users/anabel/x');
  });

  test('other folders keep their drive path; the top is no value', () => {
    expect(drivePathToParam('Company/Briefs', ME)).toBe('Company/Briefs');
    expect(drivePathFromParam('Company/Briefs', ME)).toBe('Company/Briefs');
    expect(drivePathToParam('/', ME)).toBe('');
    expect(drivePathFromParam(null, ME)).toBe('/');
    expect(drivePathFromParam('', ME)).toBe('/');
  });

  test('a folder named ~notes is not the own folder', () => {
    expect(drivePathFromParam('~notes/a', ME)).toBe('~notes/a');
  });

  test('~ without an own folder opens the top, never another folder', () => {
    expect(drivePathFromParam('~/Memory', null)).toBe('/');
  });

  test('the URL keeps slashes readable and other values intact', () => {
    expect(driveUrlWithPath('http://x/p/1/drive?tab=a', '~/My notes/a&b')).toBe(
      '/p/1/drive?tab=a&path=~/My+notes/a%26b',
    );
    expect(driveUrlWithPath('http://x/p/1/drive?path=~/a', '')).toBe('/p/1/drive');
  });

  test('extra slashes are trimmed, and a long slash run returns fast', () => {
    expect(drivePathFromParam('//Company/Briefs//', ME)).toBe('Company/Briefs');
    expect(drivePathToParam('/Company/Briefs/', ME)).toBe('Company/Briefs');
    const slashes = '/'.repeat(100_000);
    const started = performance.now();
    // The old `/\/+$/` trim took ~12 s on this input.
    expect(drivePathFromParam(`x${slashes}a`, ME)).toBe(`x${slashes}a`);
    expect(drivePathToParam(`x${slashes}a`, ME)).toBe(`x${slashes}a`);
    expect(performance.now() - started).toBeLessThan(500);
  });
});
