import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const sourcePath = join(import.meta.dir, 'connectors-view.tsx');
const source = [
  readFileSync(sourcePath, 'utf8'),
  readFileSync(join(import.meta.dir, 'discover-catalogue.tsx'), 'utf8'),
].join('\n');

describe('Slack channel connector catalogue', () => {
  test('uses the built-in Slack install flow instead of creating the reserved slug', () => {
    expect(source).toContain('<AddSlackConnectionCard projectId={projectId} onAdded={onAdded} />');
    expect(source).not.toMatch(/<ChannelConnectionCard[\s\S]*slug="kortix_slack"/);
  });

  test('keeps Slack out of the Pipedream OAuth Discover catalogue', () => {
    expect(source).toContain("new Set(['slack', 'slack_v2'])");
    expect(source).toContain('apps.filter((app) => !BUILT_IN_CHANNEL_APP_SLUGS.has(app.slug))');
    expect(source).toContain('const discoverCards = [...connectorCards, ...pipedreamOAuthCards]');
  });

  test('uses Slack branding for the built-in channel card', () => {
    expect(source).toContain(
      "SLACK_ICON_SRC = 'https://www.google.com/s2/favicons?domain=slack.com&sz=128'",
    );
    expect(source).toContain('<SlackIconTile />');
    expect(source).not.toContain('<EntityAvatar icon={Slack} size="sm" />');
  });

  test('keeps the full custom Slack app manifest setup before token fields', () => {
    expect(source).toContain("raw('textaed3545ea8e4')");
    expect(source).toContain("raw('text6e3fcca472c5')");
    expect(source).toContain("raw('textcc6e921330d3')");
    expect(source).toContain('copyManifest');
    expect(source).toContain('https://api.slack.com/apps?new_app=1');
    expect(source).toContain("raw('texta89d28175307')");
    expect(source).toContain("raw('text690ee10ca19e')");
    expect(source).toContain("raw('text2cf7a6e21f7e')");
  });
});

describe('Email channel connector catalogue', () => {
  test('keeps Email connections behind the experimental flag', () => {
    expect(source).toContain(
      '{emailChannelEnabled && <AddEmailConnectionCard projectId={projectId} onAdded={onAdded} />}',
    );
  });

  test('supports managed inbox creation and attaching an existing AgentMail inbox', () => {
    expect(source).toContain("raw('texte654b63c8098')");
    expect(source).toContain("raw('text1bb320d9db5d')");
    expect(source).toContain("raw('textd7cc97510eb3')");
    expect(source).toContain("raw('texta35f4f3f0587')");
    expect(source).toContain("raw('text2fcfd290b610')");
  });
});
