import { describe, expect, test } from 'bun:test';
import { runInNewContext } from 'node:vm';

import { shouldLoadVisitorPixel, VISITOR_PIXEL_SCRIPT, VISITOR_PIXEL_SRC } from './tracking-pixel';

function runPixel(hostname: string, userAgent: string): string[] {
  const appended: string[] = [];
  const document = {
    createElement: () => ({}) as { src?: string },
    head: { appendChild: (node: { src?: string }) => appended.push(node.src ?? '') },
  };
  runInNewContext(VISITOR_PIXEL_SCRIPT, {
    document,
    navigator: { userAgent },
    location: { hostname },
  });
  return appended;
}

describe('visitor pixel gate', () => {
  const browser = 'Mozilla/5.0 Chrome/140';
  const desktop = 'Mozilla/5.0 KortixDesktop/1.0';

  test.each([
    ['kortix.com', browser, true],
    ['www.kortix.com', browser, true],
    ['staging.kortix.com', browser, true],
    ['kortix.com', desktop, false],
    ['localhost', browser, false],
    ['preview.vercel.app', browser, false],
    ['notkortix.com', browser, false],
  ])('%s / %s -> %p', (host, ua, expected) => {
    expect(shouldLoadVisitorPixel(host, ua)).toBe(expected);
    expect(runPixel(host, ua)).toEqual(expected ? [VISITOR_PIXEL_SRC] : []);
  });
});
