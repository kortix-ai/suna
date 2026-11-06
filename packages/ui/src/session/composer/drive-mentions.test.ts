import { describe, expect, test } from 'bun:test';
import type { JSONContent } from '@tiptap/core';

import { drivePathsIn, orphanedDriveUploads, withoutDriveChips } from './drive-mentions';

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
  test('drivePathsIn names each Drive path once, and only Drive chips', () => {
    expect([...drivePathsIn(draft)]).toEqual(['/Company/a.png', '/Users/ana/a.png']);
    expect(drivePathsIn(null).size).toBe(0);
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

  test('orphanedDriveUploads: an upload whose last chip is gone; a chip that is still there keeps its upload', () => {
    const staged = new Map([
      ['/Company/a.png', 'upl_1'],
      ['/Users/ana/a.png', 'upl_2'],
      ['/Company/gone.png', 'upl_3'],
    ]);
    expect(orphanedDriveUploads(staged, draft)).toEqual(['/Company/gone.png']);
    expect(orphanedDriveUploads(staged, doc())).toEqual(['/Company/a.png', '/Users/ana/a.png', '/Company/gone.png']);
  });
});
