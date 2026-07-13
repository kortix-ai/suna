import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = import.meta.dir;
const channelsSource = readFileSync(join(dir, 'view/channels-view.tsx'), 'utf8');
const connectorsSource = readFileSync(join(dir, 'connectors-view.tsx'), 'utf8');
const teamsPanelSource = readFileSync(join(dir, 'teams-channel-panel.tsx'), 'utf8');

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
    // The bindings table renders only when a channel is connected (`install`).
    // Robust to formatting + extra props (e.g. read-only `canWrite` gating).
    expect(channelsSource).toMatch(/install \? \(?\s*<ChannelBindingsSection\b/);
  });

  test('reads/writes bindings through the shared channel-bindings hook (no ad-hoc fetches)', () => {
    expect(channelsSource).toContain("from '@/hooks/channels/use-channel-bindings'");
    expect(channelsSource).toContain('useChannelBindings');
    expect(channelsSource).toContain('useUpdateChannelBinding');
  });

  test('agent picker reuses the shared AgentSelector (same component as chat input/schedules), offering a project-default entry plus visible agents', () => {
    expect(channelsSource).toContain("from '@/features/session/session-chat-input'");
    expect(channelsSource).toContain('<AgentSelector');
    expect(channelsSource).toContain('useVisibleAgents');
    expect(channelsSource).toContain('Project default');
  });

  test('model override reuses the shared ModelSelector (not a hand-rolled input) and labels the unset state "Project default"', () => {
    expect(channelsSource).toContain("from '@/features/session/model-selector'");
    expect(channelsSource).toContain('<ModelSelector');
    expect(channelsSource).toContain('unsetLabel="Project default"');
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

describe('Channels view — Microsoft Teams is a uniform channel row', () => {
  test('renders Teams as a table row alongside Slack and Email (not a bespoke card)', () => {
    expect(channelsSource).toContain('function TeamsChannelRow');
    expect(channelsSource).toContain('<TeamsChannelRow');
    expect(channelsSource).toContain('Icon.MicrosoftTeams');
    expect(channelsSource).toMatch(/<SlackChannelRow[\s\S]*<TeamsChannelRow/);
  });

  test('reuses the shared Teams installation hooks (same source of truth as the panel)', () => {
    expect(channelsSource).toContain("from '@/hooks/channels/use-teams-installations'");
    expect(channelsSource).toContain('useTeamsInstall');
    expect(channelsSource).toContain('useTeamsMode');
    expect(channelsSource).toContain('useDisconnectTeams');
  });

  test('keeps the Teams row behind the channel feature flag', () => {
    expect(channelsSource).toContain('if (mode && !mode.enabled) return null;');
  });

  test('offers one-click Install / Add to Teams / Disconnect in the row', () => {
    expect(channelsSource).toContain('orgConsentUrl');
    expect(channelsSource).toContain('Add to Teams');
    expect(channelsSource).toContain('deepLinkUrl');
  });

  test('the standalone Teams panel is repurposed into the bring-your-own-bot card', () => {
    expect(teamsPanelSource).toContain('Bring your own Microsoft Teams bot');
    expect(teamsPanelSource).not.toContain('ConnectedPanel');
    expect(teamsPanelSource).not.toContain('DisconnectedPanel');
  });
});
