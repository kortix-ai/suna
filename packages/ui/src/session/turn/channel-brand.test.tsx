import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { CHANNEL_BRAND_COLOR, ChannelBrandMark } from './channel-brand';

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
