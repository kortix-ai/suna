import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = import.meta.dir;
const channelsSource = readFileSync(join(dir, 'view/channels-view.tsx'), 'utf8');
const connectorsSource = readFileSync(join(dir, 'connectors-view.tsx'), 'utf8');

describe('Channels view — connect in place', () => {
  test('reuses the connector connect form inside a modal instead of redirecting', () => {
    expect(channelsSource).toContain('EmailConnectForm');
    expect(channelsSource).toContain(
      "from '@/features/workspace/customize/sections/connectors-view'",
    );
    expect(channelsSource).toContain('ModalContent');
    expect(channelsSource).toContain('EmailChannelRow');
  });

  test('the connect form it depends on is exported from connectors-view', () => {
    expect(connectorsSource).toContain('export function EmailConnectForm');
  });

  test('uses the table layout for channel rows', () => {
    expect(channelsSource).toContain('<Table>');
    expect(channelsSource).toContain('SlackChannelRow');
    expect(channelsSource).toContain('EmailChannelRow');
  });

  test('offers Connect plus inline Disconnect confirmation for email', () => {
    expect(channelsSource).toContain('useDisconnectSlack');
    expect(channelsSource).toContain('useDisconnectEmail');
  });

  test('keeps Email behind the experimental flag and uses the reserved inbox slug', () => {
    expect(channelsSource).toContain('agentmail_email');
    expect(channelsSource).toContain("EMAIL_CONNECTOR_SLUG = 'kortix_email'");
    expect(channelsSource).toMatch(/emailChannelEnabled \? \(\s*<EmailChannelRow/);
  });
});
