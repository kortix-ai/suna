import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseChannelMessage } from '@kortix/ui/session/turn/channel-message';
import { ChannelMessage } from '@kortix/ui/session/turn/user-message';
import { ChannelOrigin } from '@kortix/ui/session';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { channelPromptText } from '@kortix/shared';

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

// An email turn drew a Slack pill: every header word but Teams and Telegram read as Slack.
describe('an email channel message', () => {
  test('wears the Email pill and shows the body without the instructions', () => {
    const prompt = channelPromptText({
      platform: 'Email',
      sender: 'a@b.example',
      where: 'Q3 report',
      text: 'The numbers are attached.',
      reply: `kortix connectors call email.reply_message '{"text":"<reply>"}'`,
      notes: ['Inbox <inbox_id>, thread <thread_id>.'],
    });
    const html = renderToStaticMarkup(<ChannelMessage info={parseChannelMessage(prompt)!} />);
    expect(html).toContain('>Email<');
    expect(html).toContain('a@b.example');
    expect(html).toContain('The numbers are attached.');
    expect(html).not.toContain('kortix connectors call');
    // Neither Slack's four colors nor the Telegram plane.
    expect(html).not.toContain('#36C5F0');
    expect(html).not.toContain('#29B6F6');
  });
});
