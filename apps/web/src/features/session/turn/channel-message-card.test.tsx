import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseChannelMessage } from './channel-message';
import { ChannelMessage, ChannelOrigin } from './user-message';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const slack = (text: string) =>
  parseChannelMessage(
    [
      "You're answering a message on Slack as a teammate.",
      '',
      'Workspace:  T0AB12CD',
      'Channel:    #research (C0DEV)',
      'User:       Sam Rivera (U0TESTUSER)',
      '',
      'Message:',
      text,
      '',
      'How to work:',
      '- Post progress with `slack step`.',
    ].join('\n'),
  )!;

const chips = (html: string) => [...html.matchAll(/aria-label="user mention: ([^"]+)"/g)].map((m) => m[1]);

// A Slack message drew `@KortixDev` as plain text; the composer draws the same
// mention as a chip. Typing it in Slack and typing it here now look the same.
describe('a Slack channel message', () => {
  test('draws @KortixDev and @Kortix as mention chips', () => {
    const html = renderToStaticMarkup(
      <ChannelMessage info={slack('<@U0DEVBOT|KortixDev> check what <@U0BOT|Kortix> said')} />,
    );
    expect(chips(html)).toEqual(['KortixDev', 'Kortix']);
    expect(html).toContain('Sam Rivera');
    expect(html).toContain('check what');
  });

  test('the pill is a focusable trigger; the origin card names the channel and the sender', () => {
    const pill = renderToStaticMarkup(<ChannelMessage info={slack('hi')} />);
    expect(pill).toMatch(/<button type="button"[^>]*data-state="closed"/);

    const card = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <ChannelOrigin info={slack('hi')} platform="Slack" />
      </QueryClientProvider>,
    );
    expect(card).toContain('#research');
    expect(card).toContain('Sam Rivera');
  });

  test('leaves an email address as text', () => {
    const html = renderToStaticMarkup(<ChannelMessage info={slack('mail ops@example.com')} />);
    expect(chips(html)).toEqual([]);
    expect(html).toContain('ops@example.com');
  });
});
