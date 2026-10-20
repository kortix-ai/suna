import { expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

mock.module('next/headers', () => ({ headers: async () => new Headers() }));
mock.module('./releases', () => ({
  getDesktopRelease: async () => null,
  formatSize: () => '',
  pickDesktopAsset: () => undefined,
}));
mock.module('./card-images', () => ({ DesktopCardImage: () => null, MobileCardImage: () => null }));
mock.module('./terminal-block', () => ({ TerminalBlock: () => null }));

const { default: DownloadPage } = await import('@/app/[locale]/(public)/(marketing)/download/page');

test('the desktop card offers a same-tab entry to computer pairing without a project id', async () => {
  const html = renderToStaticMarkup(await DownloadPage({ searchParams: Promise.resolve({}) }));
  const cards = html.split('<section');
  expect(cards[1]).toContain('href="/settings/computers"');
  expect(cards[1]).toContain('Connect your computer');
  expect(cards[1]).not.toContain('target="_blank"');
  expect(cards[2]).not.toContain('/settings/computers');
});
