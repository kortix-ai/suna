import { describe, expect, test } from 'bun:test';

import { formatLinkRow } from './links-overlay.tsx';

describe('formatLinkRow', () => {
  test('a short URL prints whole with its source glyph', () => {
    expect(formatLinkRow({ url: 'https://a.dev/x', source: 'terminal' }, 40)).toBe(
      '> https://a.dev/x',
    );
    expect(formatLinkRow({ url: 'https://a.dev/x', source: 'transcript' }, 40)).toBe(
      '¶ https://a.dev/x',
    );
  });

  test('a long URL is middle-elided to the width, keeping the host and the tail', () => {
    const url = `https://auth.example.com/oauth/authorize?${'a'.repeat(80)}&state=zzz`;
    const out = formatLinkRow({ url, source: 'terminal' }, 40);
    expect(out).toHaveLength(40);
    expect(out.startsWith('> https://auth.example')).toBe(true);
    expect(out.endsWith('state=zzz')).toBe(true);
    expect(out).toContain('…');
  });
});
