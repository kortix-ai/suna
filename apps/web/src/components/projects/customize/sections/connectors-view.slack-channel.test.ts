import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

const sourcePath = join(import.meta.dir, 'connectors-view.tsx');
const source = readFileSync(sourcePath, 'utf8');

describe('Slack channel connector catalogue', () => {
  test('uses the built-in Slack install flow instead of creating the reserved slug', () => {
    expect(source).toContain('<AddSlackProfileCard projectId={projectId} onAdded={onAdded} />');
    expect(source).not.toMatch(/<ChannelProfileCard[\s\S]*slug="kortix_slack"/);
  });

  test('keeps Slack out of the Pipedream Easy Connect catalogue', () => {
    expect(source).toContain("new Set(['slack', 'slack_v2'])");
    expect(source).toContain(
      'const visibleApps = apps.filter((app) => !BUILT_IN_CHANNEL_APP_SLUGS.has(app.slug));',
    );
    expect(source).toContain('{visibleApps.map((app) => (');
  });

  test('uses Slack branding for the built-in channel card', () => {
    expect(source).toContain(
      "SLACK_ICON_SRC = 'https://www.google.com/s2/favicons?domain=slack.com&sz=128'",
    );
    expect(source).toContain('<SlackIconTile />');
    expect(source).not.toContain('<EntityAvatar icon={Slack} size="sm" />');
  });

  test('keeps the full custom Slack app manifest setup before token fields', () => {
    expect(source).toContain('Use custom Slack app');
    expect(source).toContain('Bring your own Slack app');
    expect(source).toContain('App manifest');
    expect(source).toContain('copyManifest');
    expect(source).toContain('https://api.slack.com/apps?new_app=1');
    expect(source).toContain('Click Open Slack, choose "From a manifest", paste the JSON, confirm.');
    expect(source).toContain('On the next screen, click Install to Workspace and approve.');
    expect(source).toContain('Copy the Bot User OAuth Token (xoxb-...) and Signing Secret.');
  });
});

describe('Email channel connector catalogue', () => {
  test('keeps Email profiles behind the experimental flag', () => {
    expect(source).toContain('{emailChannelEnabled && <AddEmailProfileCard projectId={projectId} onAdded={onAdded} />}');
  });

  test('supports managed inbox creation and attaching an existing AgentMail inbox', () => {
    expect(source).toContain('Create managed Email inbox');
    expect(source).toContain('Use custom AgentMail key');
    expect(source).toContain('Attach existing AgentMail inbox');
    expect(source).toContain('Existing inbox ID');
    expect(source).toContain('Existing inbox email');
  });
});
