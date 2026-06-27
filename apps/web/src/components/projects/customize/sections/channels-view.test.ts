import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = import.meta.dir;
const channelsSource = readFileSync(join(dir, 'channels-view.tsx'), 'utf8');
const connectorsSource = readFileSync(join(dir, 'connectors-view.tsx'), 'utf8');

describe('Channels view — connect in place', () => {
  test('reuses the connector connect forms inside an in-page dialog instead of redirecting', () => {
    expect(channelsSource).toContain('SlackConnectForm');
    expect(channelsSource).toContain('EmailConnectForm');
    expect(channelsSource).toContain(
      "from '@/components/projects/customize/sections/connectors-view'",
    );
    expect(channelsSource).toContain('ChannelConnectDialog');
  });

  test('the connect forms it depends on are exported from connectors-view', () => {
    expect(connectorsSource).toContain('export function SlackConnectForm');
    expect(connectorsSource).toContain('export function EmailConnectForm');
  });

  test('drops the "no separate setup" copy and the redirect-only Add channel button', () => {
    expect(channelsSource).not.toContain('Channels no longer have separate setup');
    expect(channelsSource).not.toContain('Add channel');
  });

  test('offers Connect plus a Disconnect confirmation for each channel', () => {
    expect(channelsSource).toContain('useDisconnectSlack');
    expect(channelsSource).toContain('useDisconnectEmail');
    expect(channelsSource).toContain('Disconnect Slack?');
    expect(channelsSource).toContain('Disconnect Email?');
  });

  test('keeps Email behind the experimental flag and uses the reserved inbox slug', () => {
    expect(channelsSource).toContain('agentmail_email');
    expect(channelsSource).toContain("EMAIL_CONNECTOR_SLUG = 'kortix_email'");
    expect(channelsSource).toMatch(/emailChannelEnabled && \(\s*<EmailChannelCard/);
  });
});
