import { beforeEach, describe, expect, mock, test } from 'bun:test';
// The mock below replaces the whole barrel, so it spreads the real module:
// consumers deep in the graph bind names this suite never stubs
// (`resetIdentityState`, `useConnectTeams`), and a missing binding fails
// the module link, not just the render.
import * as sdkReact from '@kortix/sdk/react';
import { renderToStaticMarkup } from 'react-dom/server';

let emailEnabled = false;
let canWrite = true;
const emailInstall = mock(() => ({ data: null, isLoading: false }));
const disconnected = () => ({ data: null, isLoading: false });
const disconnect = () => ({ isPending: false, mutate: mock() });

mock.module('@kortix/sdk/react', () => ({
  ...sdkReact,
  useFeatureFlag: () => ({ enabled: emailEnabled, isLoading: false }),
  useVisibleAgents: () => [],
  useRuntimeProviders: disconnected,
  modelKeyToWire: ({ providerID, modelID }: { providerID: string; modelID: string }) =>
    `${providerID}/${modelID}`,
  flattenModels: () => [],
  modelProviderMode: () => 'gateway' as const,
}));
mock.module('@kortix/ui/internal/lib/use-project-can', () => ({
  useProjectCan: () => ({ allowed: canWrite }),
}));
mock.module('@kortix/ui/internal/hooks/channels/use-channels-installations', () => ({
  useSlackInstall: disconnected,
  useSlackMode: disconnected,
  useEmailInstall: emailInstall,
  useDisconnectSlack: disconnect,
  useDisconnectEmail: disconnect,
  useConnectSlack: () => ({ isPending: false, mutate: mock(), mutateAsync: mock() }),
  useSlackManifest: () => ({ data: null }),
}));
mock.module('@/hooks/channels/use-teams-installations', () => ({
  useTeamsInstall: disconnected,
  useTeamsMode: disconnected,
  useDisconnectTeams: disconnect,
  useConnectTeams: () => ({ isPending: false, mutate: mock(), mutateAsync: mock() }),
  useTeamsManifest: () => ({ data: null }),
}));
mock.module('@kortix/ui/internal/hooks/use-channel-bindings', () => ({
  useChannelBindings: () => ({ data: { bindings: [] }, isLoading: false }),
  useUpdateChannelBinding: disconnect,
}));
mock.module('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/projects/email-test/connectors',
  useRouter: () => ({ replace: mock() }),
}));
// Unrelated channel setup and session pickers need live runtime providers.
// Keep the actual ChannelsSection, EmailChannelRow, ChannelRow and Button/Link.
mock.module('@kortix/ui/customize/sections/component/slack-connect-card', () => ({
  SlackConnectCard: () => null,
}));
mock.module('@/features/workspace/customize/sections/teams-channel-panel', () => ({
  TeamsChannelPanel: () => null,
}));
mock.module('@kortix/ui/customize/sections/connectors-view', () => ({
  EmailConnectForm: () => null,
}));
mock.module('@kortix/ui/session/models/model-selector', () => ({ ModelSelector: () => null }));
mock.module('@kortix/ui/session/composer/session-chat-input', () => ({
  AgentSelector: () => null,
}));

const { ChannelsSection } = await import('@kortix/ui/customize/sections/view/channels-view');

function renderEmailRow() {
  const markup = renderToStaticMarkup(<ChannelsSection projectId="email-test" />);
  const row = markup
    .match(/<li\b[^>]*>[\s\S]*?<\/li>/g)
    ?.find((item) => item.includes('>Email</p>'));
  expect(row).toBeDefined();
  return row ?? '';
}

beforeEach(() => {
  emailEnabled = false;
  canWrite = true;
  emailInstall.mockClear();
});

describe('ChannelsSection — Email availability', () => {
  test('flag off keeps Email visible with Feature flags navigation, not Install', () => {
    const row = renderEmailRow();
    expect(row).toContain('AgentMail Email is off for this project');
    expect(row).toContain('href="/projects/email-test/customize/settings?section=feature-flags"');
    expect(row).toContain('>Feature flags</a>');
    expect(row).not.toMatch(/>(?:Install|Connect)<\/button>/);
    expect(emailInstall).toHaveBeenCalledWith(null, 'kortix_email');
  });

  test('read-only members can still find Email and navigate to Feature flags', () => {
    canWrite = false;
    const row = renderEmailRow();
    expect(row).toContain('href="/projects/email-test/customize/settings?section=feature-flags"');
    expect(row).toContain('>Feature flags</a>');
    expect(row).not.toMatch(/>(?:Install|Connect)<\/button>/);
  });

  test('flag on retains the disconnected Email install action', () => {
    emailEnabled = true;
    const row = renderEmailRow();
    expect(row).toContain('Give your agent an inbox it can read and reply from.');
    expect(row).toContain('>Connect</button>');
    expect(row).not.toContain('>Feature flags</a>');
    expect(emailInstall).toHaveBeenCalledWith('email-test', 'kortix_email');
  });
});
