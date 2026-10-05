import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

/**
 * Mobile showed a current Slack or Microsoft Teams prompt as raw scaffold text:
 * its parser knew only the pre-2026 header. It now reads prompts with the web's
 * parser (`@kortix/shared` `parseChannelMessage`) and draws each platform's mark.
 */
const read = (path: string) => readFileSync(`${import.meta.dir}/${path}`, 'utf8');
const mobileMark = read('teams-icon.tsx');
const webMark = read('../../../web/src/features/icon/icons/microsoft-teams.tsx');
const userMessage = read('../session/turn/user-message.tsx');

/** Every drawing attribute of the mark, in order, with ids normalised. */
function drawing(source: string): string[] {
  const attrs = [...source.matchAll(/\b(d|fill|fillOpacity|stopColor|stopOpacity|offset|gradientTransform|x1|x2|y1|y2|cx|cy|r|width|height|x|y|rx)="([^"]*)"/g)];
  return attrs.map(([, name, value]) => `${name}=${value.replace('#teams-', '#')}`);
}

describe('the mobile Microsoft Teams mark', () => {
  test('is the web mark, element for element', () => {
    const mobile = drawing(mobileMark.slice(mobileMark.indexOf('<Svg')));
    const web = drawing(webMark.slice(webMark.indexOf('<svg')));
    expect(mobile.length).toBeGreaterThan(100);
    expect(mobile).toEqual(web);
  });

  test('its gradient ids cannot collide with another mark on the screen', () => {
    expect(mobileMark).not.toMatch(/\bid="[a-l]"/);
    expect(mobileMark).toContain('id="teams-a"');
  });
});

describe('the mobile channel card', () => {
  test('reads Slack, Teams and Telegram prompts with the shared parser, current and pre-2026', () => {
    expect(userMessage).toContain("parseChannelMessage } from '@kortix/shared'");
    expect(userMessage).toContain('parseChannelMessage(rawText)');
    expect(userMessage).not.toContain('parseLegacyChannelMessage');
  });

  test("draws each platform's own mark, and names Teams in full", () => {
    expect(userMessage).toMatch(/platform === 'Teams' \? <TeamsIcon size=\{size\} \/>/);
    expect(userMessage).toMatch(/platform === 'Slack' \? <SlackIcon size=\{size\} \/>/);
    expect(userMessage).toContain("Teams: 'Microsoft Teams'");
  });
});
