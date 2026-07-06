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

describe('Channels view — per-channel binding management (spec §2.5)', () => {
  test('renders the channel-bindings table only once a channel is connected', () => {
    expect(channelsSource).toContain('function ChannelBindingsSection');
    expect(channelsSource).toContain('install ? <ChannelBindingsSection projectId={projectId} /> : null');
  });

  test('reads/writes bindings through the shared channel-bindings hook (no ad-hoc fetches)', () => {
    expect(channelsSource).toContain("from '@/hooks/channels/use-channel-bindings'");
    expect(channelsSource).toContain('useChannelBindings');
    expect(channelsSource).toContain('useUpdateChannelBinding');
  });

  test('agent picker offers the project default plus the declared/discovered agents', () => {
    expect(channelsSource).toContain('AGENT_DEFAULT_VALUE');
    expect(channelsSource).toContain('declaredAgents');
    expect(channelsSource).toContain('Project default');
  });

  test('model override reuses the shared ModelSelector (not a hand-rolled input)', () => {
    expect(channelsSource).toContain("from '@/features/session/model-selector'");
    expect(channelsSource).toContain('<ModelSelector');
  });

  test('join-policy picker covers all three conversation policies', () => {
    expect(channelsSource).toContain("value: 'project_open'");
    expect(channelsSource).toContain("value: 'owner_only'");
    expect(channelsSource).toContain("value: 'owner_approval'");
  });

  test('read-only members see static values instead of editable controls', () => {
    expect(channelsSource).toContain('canManage');
    expect(channelsSource).toContain('disabled={!canManage');
  });
});
