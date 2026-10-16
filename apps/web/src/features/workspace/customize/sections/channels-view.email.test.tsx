import * as sdkReact from '@kortix/sdk/react';
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

let emailEnabled = false;
let canWrite = true;
const emailInstall = mock(() => ({ data: null, isLoading: false }));
const disconnected = () => ({ data: null, isLoading: false });
const disconnect = () => ({ isPending: false, mutate: mock() });

// Spread the real SDK and stub only what this test drives: the component
// chain reads more of the SDK (`qk`, `contract`, `resetIdentityState`) than
// any hand-written list can keep up with, and a missing export there fails
// the whole file with a missing-export error.
mock.module('@kortix/sdk/react', () => ({
  ...sdkReact,
  useFeatureFlag: () => ({ enabled: emailEnabled, isLoading: false }),
  useVisibleAgents: () => [],
  useRuntimeProviders: disconnected,
  modelKeyToWire: ({ providerID, modelID }: { providerID: string; modelID: string }) => `${providerID}/${modelID}`,
  flattenModels: () => [],
  modelProviderMode: () => 'gateway' as const,
}));
mock.module('@/lib/use-project-can', () => ({
  useProjectCan: () => ({ allowed: canWrite }),
}));
mock.module('@/hooks/channels/use-channels-installations', () => ({
  useSlackInstall: disconnected,
  useSlackMode: disconnected,
  useEmailInstall: emailInstall,
  useDisconnectSlack: disconnect,
  useDisconnectEmail: disconnect,
}));
mock.module('@/hooks/channels/use-teams-installations', () => ({
  // `teams-byo-wizard` reads `useConnectTeams`/`useTeamsManifest` too; a mock
  // without them makes the import fail with a missing-export error.
  useConnectTeams: disconnect,
  useTeamsManifest: disconnected,
  useTeamsInstall: disconnected,
  useTeamsMode: disconnected,
  useDisconnectTeams: disconnect,
}));
mock.module('@/hooks/channels/use-channel-bindings', () => ({
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
mock.module('@/features/workspace/customize/sections/component/slack-connect-card', () => ({
  SlackConnectCard: () => null,
}));
mock.module('@/features/workspace/customize/sections/teams-channel-panel', () => ({
  TeamsChannelPanel: () => null,
}));
mock.module('@/features/workspace/customize/sections/connectors-view', () => ({
  EmailConnectForm: () => null,
}));
mock.module('@/features/session/model-selector', () => ({ ModelSelector: () => null }));
mock.module('@/features/session/session-chat-input', () => ({
  AgentSelector: () => null,
}));

const { ChannelsSection } = await import('./view/channels-view');

function renderEmailRow() {
  const markup = renderToStaticMarkup(<ChannelsSection projectId="email-test" />);
  const row = markup.match(/<li\b[^>]*>[\s\S]*?<\/li>/g)?.find((item) => item.includes('>Email</p>'));
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
