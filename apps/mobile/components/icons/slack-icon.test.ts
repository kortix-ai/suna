import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

/**
 * Slack is drawn with Slack's own four-color mark on mobile, as on web. The
 * channel card drew a one-color glyph and its label in pink
 * hsl(339.6 82.2% 51.6%) (#E91E63), a color Slack does not use, and the
 * session starter line drew Slack as a gray glyph.
 */
const read = (path: string) => readFileSync(`${import.meta.dir}/${path}`, 'utf8');
const mobileMark = read('slack-icon.tsx');
const webMark = read('../../../web/src/features/icon/icons/slack.tsx');
const userMessage = read('../session/turn/user-message.tsx');
const sessionTree = read('../session/SessionTreeParts.tsx');

const marks = (source: string) =>
  [...source.matchAll(/fill="(#[0-9A-Fa-f]{6})"[^>]*?d="([^"]+)"/gs)].map(([, fill, d]) => ({ fill, d }));

describe('the mobile Slack mark', () => {
  test("is the web mark: Slack's four colors, the same paths", () => {
    expect(marks(mobileMark).map((m) => m.fill)).toEqual(['#36C5F0', '#2EB67D', '#ECB22E', '#E01E5A']);
    expect(marks(mobileMark)).toEqual(marks(webMark));
  });

  test('the channel card draws it, and its label is not tinted pink', () => {
    expect(userMessage).not.toContain('339.6 82.2% 51.6%');
    expect(userMessage).toMatch(/platform === 'Slack'\)? (\?|return) <SlackIcon size=\{size\} \/>/);
  });

  test('the session starter line draws it for a Slack-started session', () => {
    expect(sessionTree).toMatch(/starter\.icon === 'slack' \? \(?\s*<SlackIcon size=\{12\} \/>/);
    expect(sessionTree).not.toContain('SlackLogoIcon');
  });
});
