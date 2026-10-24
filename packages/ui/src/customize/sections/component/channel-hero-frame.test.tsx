import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import en from '../../../../../../apps/web/translations/en.json';
import { IntlTestProvider as NextIntlClientProvider } from '../../../test-utils/intl';
import { stripTags } from '../../../test-utils/strip-tags';
import { ChannelHeroLayoutProvider } from './channel-hero-frame';
import { ChannelRow } from './channel-row';

/**
 * A Kortix channel's own page draws its row as a hero: the pitch and the
 * connect action when it is not connected, and "Connected · <what>" with the
 * row's own manage actions when it is. In a list it stays a row.
 */
function render(node: React.ReactNode, hero: boolean): string {
  const tree = hero ? <ChannelHeroLayoutProvider>{node}</ChannelHeroLayoutProvider> : node;
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" timeZone="UTC" messages={en}>
      {tree}
    </NextIntlClientProvider>,
  );
}

const row = (connected: boolean) => (
  <ChannelRow
    icon={<span />}
    name="Telegram"
    connected={connected}
    detail={connected ? '@acme_bot' : null}
    pitch="Message the agent from Telegram."
    actions={<button type="button">{connected ? 'Disconnect' : 'Connect'}</button>}
    hero={{ title: 'Bring your agent to Telegram', connectedTitle: 'Your agent is in Telegram', preview: <p>mock chat</p> }}
  />
);

describe('a channel drawn as its page hero', () => {
  test('not connected: the pitch title, the lede and the connect action, with the preview', () => {
    const text = stripTags(render(row(false), true));
    expect(text).toContain('Bring your agent to Telegram');
    expect(text).toContain('Message the agent from Telegram.');
    expect(text).toContain('Connect');
    expect(text).toContain('mock chat');
    expect(text).not.toContain('Connected');
  });

  test('connected: the connected title, "Connected · <what>" and the manage actions', () => {
    const text = stripTags(render(row(true), true));
    expect(text).toContain('Your agent is in Telegram');
    expect(text).toContain('Connected');
    expect(text).toContain('@acme_bot');
    expect(text).toContain('Disconnect');
  });

  test('in the Channels list it stays a row', () => {
    const html = render(row(true), false);
    expect(html.startsWith('<li')).toBe(true);
    expect(stripTags(html)).not.toContain('Your agent is in Telegram');
  });
});
