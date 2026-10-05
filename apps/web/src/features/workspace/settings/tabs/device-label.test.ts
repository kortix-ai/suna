import { describe, expect, test } from 'bun:test';
import { describeUserAgent } from './device-label';

describe('describeUserAgent', () => {
  const cases: [string, ReturnType<typeof describeUserAgent>][] = [
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
      { browser: 'Chrome', os: 'macOS', mobile: false },
    ],
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:156.0) Gecko/20100101 Firefox/156.0',
      { browser: 'Firefox', os: 'macOS', mobile: false },
    ],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
      { browser: 'Safari', os: 'iOS', mobile: true },
    ],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0',
      { browser: 'Edge', os: 'Windows', mobile: false },
    ],
    [
      'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
      { browser: 'Chrome', os: 'Android', mobile: true },
    ],
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Kortix/1.4.0 Chrome/140.0.0.0 Electron/38.0.0 Safari/537.36',
      { browser: 'Kortix desktop', os: 'macOS', mobile: false },
    ],
    ['Bun/1.3.14', { browser: 'Bun', os: null, mobile: false }],
    ['', { browser: null, os: null, mobile: false }],
    [null as unknown as string, { browser: null, os: null, mobile: false }],
  ];
  for (const [ua, expected] of cases) {
    test(String(ua).slice(0, 60) || '(empty)', () => {
      expect(describeUserAgent(ua)).toEqual(expected);
    });
  }
});
