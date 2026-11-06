import { describe, expect, test } from 'bun:test';
import type { JSONContent } from '@tiptap/core';

import { driveChipsIn, driveUploadName, driveUploadsOf, drivePathsIn, withoutDriveChips } from './drive-mentions';

const chip = (kind: string, label: string, value: string): JSONContent => ({ type: 'mention', attrs: { kind, label, value } });
const doc = (...inline: JSONContent[]): JSONContent => ({ type: 'doc', content: [{ type: 'paragraph', content: inline }] });

const draft = doc(
  chip('drive', 'a.png', '/Company/a.png'),
  { type: 'text', text: ' and ' },
  chip('drive', 'a.png', '/Users/ana/a.png'),
  chip('file', 'a.png', 'a.png'),
  chip('agent', 'build', 'build'),
);

describe('Drive chips in the composer document', () => {
  test('drivePathsIn names each Drive path once, and only Drive chips; driveChipsIn adds the name to fetch it by', () => {
    expect([...drivePathsIn(draft)]).toEqual(['/Company/a.png', '/Users/ana/a.png']);
    expect(drivePathsIn(null).size).toBe(0);
    expect([...driveChipsIn(doc(chip('drive', 'a.png', '/Company/a.png'), chip('drive', 'a.png', '/Company/a.png')))]).toEqual([
      ['/Company/a.png', 'a.png'],
    ]);
  });

  test('withoutDriveChips takes back only the chips of that path', () => {
    expect(withoutDriveChips(draft, '/Company/a.png')).toEqual(
      doc(
        { type: 'text', text: ' and ' },
        chip('drive', 'a.png', '/Users/ana/a.png'),
        chip('file', 'a.png', 'a.png'),
        chip('agent', 'build', 'build'),
      ),
    );
  });

  test('driveUploadName keeps the name unless the tray holds it; then the folder tells the two apart', () => {
    expect(driveUploadName('logo.png', '/Company/brand/logo.png', ['a.txt'])).toBe('logo.png');
    expect(driveUploadName('logo.png', '/Company/brand/logo.png', ['logo.png'])).toBe('logo (brand).png');
    expect(driveUploadName('logo.png', '/Company/brand/logo.png', ['logo.png', 'logo (brand).png'])).toBe('logo (brand 2).png');
    expect(driveUploadName('README', '/README', ['README'])).toBe('README (Drive)');
  });

  test('driveUploadsOf lists only the tray files staged from Drive, with their upload names', () => {
    const file = new File(['x'], 'logo (brand).png');
    expect(
      driveUploadsOf([
        { kind: 'local', file, localUrl: 'blob:1', isImage: true, drivePath: '/Company/brand/logo.png' },
        { kind: 'local', file: new File(['y'], 'mine.txt'), localUrl: 'blob:2', isImage: false },
        { kind: 'uploaded', uploadId: 'u1', filename: 'a b.png', mime: 'image/png', size: 3, isImage: false, drivePath: '/a b.png' },
        { kind: 'remote', url: 'https://x', filename: 'r.png', mime: 'image/png', isImage: true },
      ]),
    ).toEqual([
      { name: 'logo (brand).png', drivePath: '/Company/brand/logo.png' },
      { name: 'a b.png', drivePath: '/a b.png' },
    ]);
  });
});
