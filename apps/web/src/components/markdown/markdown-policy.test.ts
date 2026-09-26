import { describe, expect, test } from 'bun:test';

import {
  markdownPolicy,
  type MarkdownPolicy,
  type MarkdownTrust,
  type MarkdownVariant,
} from './markdown-policy';

// The whole contract in one table: who wrote the text × how it is shown.
const TABLE: [MarkdownTrust, MarkdownVariant, MarkdownPolicy][] = [
  ['trusted', 'message', { rawHtml: true, remoteImages: 'load', setupLinks: false }],
  ['trusted', 'document', { rawHtml: false, remoteImages: 'load', setupLinks: false }],
  ['agent', 'message', { rawHtml: true, remoteImages: 'load', setupLinks: true }],
  ['agent', 'document', { rawHtml: false, remoteImages: 'load', setupLinks: true }],
  ['untrusted', 'message', { rawHtml: true, remoteImages: 'click-to-load', setupLinks: false }],
  ['untrusted', 'document', { rawHtml: false, remoteImages: 'click-to-load', setupLinks: false }],
];

describe('markdownPolicy', () => {
  for (const [trust, variant, expected] of TABLE) {
    test(`${trust} ${variant}`, () => {
      expect({ ...markdownPolicy(trust, variant) }).toEqual(expected);
    });
  }

  test('a message is the default variant', () => {
    expect(markdownPolicy('agent')).toBe(markdownPolicy('agent', 'message'));
  });

  test('only agent text raises setup-link cards', () => {
    const raising = TABLE.filter(([, , p]) => p.setupLinks).map(([trust]) => trust);
    expect(new Set(raising)).toEqual(new Set(['agent']));
  });

  test('only untrusted text defers remote images', () => {
    const deferring = TABLE.filter(([, , p]) => p.remoteImages === 'click-to-load').map(
      ([trust]) => trust,
    );
    expect(new Set(deferring)).toEqual(new Set(['untrusted']));
  });

  test('each policy is one stable, frozen object', () => {
    // The renderer keys its context memo and plugin choice on this identity.
    expect(markdownPolicy('untrusted', 'document')).toBe(markdownPolicy('untrusted', 'document'));
    expect(Object.isFrozen(markdownPolicy('agent'))).toBe(true);
  });
});
