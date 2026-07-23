import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

const dir = import.meta.dir;
const connectorsSource = readFileSync(join(dir, 'connectors-view.tsx'), 'utf8');
const bindingsSource = readFileSync(join(dir, 'channel-bindings-section.tsx'), 'utf8');
const customizePanelSource = readFileSync(
  join(dir, '..', 'customize-panel.tsx'),
  'utf8',
);

// Channels was folded into Connectors — one sidebar surface for every
// channel-related capability (connect, profiles, and channel→agent
// bindings). These tests pin that shape so it doesn't regress back into two
// sections.

describe('Customize rail — Channels is not a separate section', () => {
  test('the rail has no Channels entry and no ChannelsView render branch', () => {
    expect(customizePanelSource).not.toMatch(/section:\s*'channels'/);
    expect(customizePanelSource).not.toContain('ChannelsView');
    expect(customizePanelSource).not.toContain("case 'channels'");
  });
});

describe('Connectors view — Microsoft Teams is a channel profile (mirrors Slack/Email)', () => {
  test('routes a kortix_teams connector to the Teams channel profile', () => {
    expect(connectorsSource).toContain('function TeamsChannelProfile');
    expect(connectorsSource).toContain("TEAMS_CONNECTOR_SLUG = 'kortix_teams'");
    expect(connectorsSource).toMatch(/if \(platform === 'teams'\)[\s\S]*<TeamsChannelProfile/);
  });

  test('reuses the shared Teams installation hooks (same source of truth as before)', () => {
    expect(connectorsSource).toContain("from '@/hooks/channels/use-teams-installations'");
    expect(connectorsSource).toContain('useTeamsInstall');
    expect(connectorsSource).toContain('useTeamsMode');
    expect(connectorsSource).toContain('useConnectTeams');
    expect(connectorsSource).toContain('useDisconnectTeams');
  });

  test('offers a Teams catalogue card gated behind the Teams feature flag', () => {
    expect(connectorsSource).toContain('function AddTeamsProfileCard');
    expect(connectorsSource).toContain('teamsMode.data?.enabled === true');
    expect(connectorsSource).toMatch(/\{teamsEnabled && <AddTeamsProfileCard/);
  });

  test('supports the managed app-manifest flow and the bring-your-own Azure bot fallback', () => {
    expect(connectorsSource).toContain('function TeamsConnectForm');
    expect(connectorsSource).toContain('Use custom Azure bot');
    expect(connectorsSource).toContain('Azure AD tenant ID');
    expect(connectorsSource).toContain('Grant admin consent');
  });
});

describe('Connectors view — per-channel binding management (spec §2.5), ported from Channels', () => {
  test('ChannelBindingsSection lives in a shared module Connectors imports', () => {
    expect(connectorsSource).toContain(
      "from '@/features/workspace/customize/sections/channel-bindings-section'",
    );
    expect(bindingsSource).toContain('export function ChannelBindingsSection');
    expect(bindingsSource).toContain('function ChannelBindingTableRow');
  });

  test('is scoped per channel platform so Slack/Teams/Email each see only their own bindings', () => {
    expect(connectorsSource).toMatch(/<ChannelBindingsSection[^>]*platform="slack"/);
    expect(connectorsSource).toMatch(/<ChannelBindingsSection[^>]*platform="teams"/);
    expect(connectorsSource).toMatch(/<ChannelBindingsSection[^>]*platform="email"/);
    expect(bindingsSource).toContain("all.filter((b) => b.platform === platform)");
  });

  test('reads/writes bindings through the shared channel-bindings hook (no ad-hoc fetches)', () => {
    expect(bindingsSource).toContain("from '@/hooks/channels/use-channel-bindings'");
    expect(bindingsSource).toContain('useChannelBindings');
    expect(bindingsSource).toContain('useUpdateChannelBinding');
  });

  test('agent picker reuses the shared AgentSelector, offering a project-default entry plus visible agents', () => {
    expect(bindingsSource).toContain("from '@/features/session/session-chat-input'");
    expect(bindingsSource).toContain('<AgentSelector');
    expect(bindingsSource).toContain('useVisibleAgents');
    expect(bindingsSource).toContain('Project default');
  });

  test('model override reuses the shared ModelSelector and labels the unset state "Project default"', () => {
    expect(bindingsSource).toContain("from '@/features/session/model-selector'");
    expect(bindingsSource).toContain('<ModelSelector');
    expect(bindingsSource).toContain('unsetLabel="Project default"');
  });

  test('join-policy picker covers all three conversation policies', () => {
    expect(bindingsSource).toContain("value: 'project_open'");
    expect(bindingsSource).toContain("value: 'owner_only'");
    expect(bindingsSource).toContain("value: 'owner_approval'");
  });

  test('read-only members see static values instead of editable controls', () => {
    expect(bindingsSource).toContain('canManage');
    expect(bindingsSource).toContain('disabled={!canManage');
  });
});
