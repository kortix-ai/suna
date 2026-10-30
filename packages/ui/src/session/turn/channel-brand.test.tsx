import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { Email } from '../../internal/icons/email';
import { CHANNEL_BRAND_COLOR, ChannelBrandMark } from './channel-brand';
import type { ChannelPlatform } from './channel-message';

// The Slack badge on a session's channel card was a one-color glyph in
// Material pink (#E91E63), with a pink "Slack" beside it: no Slack color at all.
describe('the Slack badge', () => {
  test("is Slack's own four-color mark", () => {
    const svg = renderToStaticMarkup(<ChannelBrandMark platform="Slack" />);
    for (const hue of ['#36C5F0', '#2EB67D', '#ECB22E', '#E01E5A']) expect(svg).toContain(hue);
    expect(svg).not.toContain('#E91E63');
  });

  test("its label is not tinted: Slack's wordmark is the text color, black or white", () => {
    expect(CHANNEL_BRAND_COLOR.Slack).toBeUndefined();
    expect(CHANNEL_BRAND_COLOR.Teams).toBe('#5B5FC7');
    expect(CHANNEL_BRAND_COLOR.Telegram).toBe('#29B6F6');
  });
});

// Any platform but Teams and Slack drew the Telegram plane.
describe('a badge with no brand of its own', () => {
  test('Email is the envelope an email session wears in the sidebar, in the text color', () => {
    expect(renderToStaticMarkup(<ChannelBrandMark platform="Email" />)).toBe(
      renderToStaticMarkup(<Email className="size-3.5 shrink-0" />),
    );
    expect(CHANNEL_BRAND_COLOR.Email).toBeUndefined();
  });

  test('a platform this build does not know is a neutral mark in the text color, not the Telegram plane', () => {
    const svg = renderToStaticMarkup(<ChannelBrandMark platform={'Discord' as ChannelPlatform} />);
    expect(svg).toContain('currentColor');
    expect(svg).not.toContain('#29B6F6');
  });
});
