import { describe, expect, test } from 'bun:test';
import { describeUserAgent } from './device-label';

describe('describeUserAgent', () => {
  const cases: [string, ReturnType<typeof describeUserAgent>][] = [
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
      { browser: 'Chrome', os: 'macOS', mobile: false, brand: 'chrome' },
    ],
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:156.0) Gecko/20100101 Firefox/156.0',
      { browser: 'Firefox', os: 'macOS', mobile: false, brand: 'firefox' },
    ],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
      { browser: 'Safari', os: 'iOS', mobile: true, brand: 'safari' },
    ],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0',
      { browser: 'Edge', os: 'Windows', mobile: false, brand: 'edge' },
    ],
    [
      'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
      { browser: 'Chrome', os: 'Android', mobile: true, brand: 'chrome' },
    ],
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Kortix/1.4.0 Chrome/140.0.0.0 Electron/38.0.0 Safari/537.36',
      { browser: 'Kortix desktop', os: 'macOS', mobile: false, brand: null },
    ],
    ['Bun/1.3.14', { browser: 'Bun', os: null, mobile: false, brand: 'bun' }],
    ['', { browser: null, os: null, mobile: false, brand: null }],
    [
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Konqueror/5',
      { browser: null, os: 'Linux', mobile: false, brand: 'linux' },
    ],
    [
      'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
      { browser: 'Chrome', os: 'ChromeOS', mobile: false, brand: 'chrome' },
    ],
    [null as unknown as string, { browser: null, os: null, mobile: false, brand: null }],
  ];
  for (const [ua, expected] of cases) {
    test(String(ua).slice(0, 60) || '(empty)', () => {
      expect(describeUserAgent(ua)).toEqual(expected);
    });
  }
});
