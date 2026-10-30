import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { DownloadOptions } from './download-options';

for (const detected of ['macos', 'android'] as const) {
  test(`${detected} visitors can reach computer pairing from the desktop card`, () => {
    const html = renderToStaticMarkup(<DownloadOptions detected={detected} />);
    const cards = html.split('<section');
    expect(cards[1]).toContain('href="/settings/computer"');
    expect(cards[1]).toContain('Connect your computer');
    expect(cards[1]).not.toContain('target="_blank"');
    expect(cards[2]).not.toContain('/settings/computer');
    expect(html).toContain('href="/download/macos"');
    expect(html).toContain('https://apps.apple.com/app/kortix/id6754448524');
  });
}
