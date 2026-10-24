import { beforeEach, describe, expect, mock, test } from 'bun:test';
// The mock below replaces the whole barrel, so it spreads the real module:
// consumers deep in the graph bind names this suite never stubs
// (`resetIdentityState`, `useConnectTeams`), and a missing binding fails
// the module link, not just the render.
import * as sdkReact from '@kortix/sdk/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';

let canWrite = true;
let emailChannel = true;
const emailInstall = mock(() => ({ data: null, isLoading: false }));
const disconnected = () => ({ data: null, isLoading: false });
const disconnect = () => ({ isPending: false, mutate: mock() });

mock.module('@kortix/sdk/react', () => ({
  ...sdkReact,
  useFeatureFlag: (_projectId: string, key: string) => ({
    enabled: key === 'email_channel' ? emailChannel : true,
    isLoading: false,
  }),
  useVisibleAgents: () => [],
  useRuntimeProviders: disconnected,
  modelKeyToWire: ({ providerID, modelID }: { providerID: string; modelID: string }) =>
    `${providerID}/${modelID}`,
  flattenModels: () => [],
  modelProviderMode: () => 'gateway' as const,
  // channels-view reads Teams from the SDK directly.
  useTeamsInstall: disconnected,
  useTeamsMode: disconnected,
  useDisconnectTeams: disconnect,
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
  SlackChannelMock: () => null,
}));
// Telegram (connectors_v2, on here with every flag) reads its install hooks
// through a QueryClient this suite does not mount.
mock.module('@kortix/ui/customize/sections/component/telegram-channel-row', () => ({
  TelegramChannelRow: () => null,
}));
mock.module('@kortix/ui/customize/sections/component/teams-connect-card', () => ({
  TeamsConnectCard: () => null,
  TeamsChannelMock: () => null,
}));
mock.module('@kortix/ui/customize/sections/connectors-view', () => ({
  EmailConnectForm: () => null,
}));
// The Computer hero reads paired machines through a QueryClient this suite does not mount.
mock.module('@kortix/ui/customize/connectors/detail/computer-app-page', () => ({
  ComputerHero: () => null,
}));
mock.module('@kortix/ui/session/models/model-selector', () => ({ ModelSelector: () => null }));
mock.module('@kortix/ui/session/composer/session-chat-input', () => ({
  AgentSelector: () => null,
}));

const { ChannelsSection } = await import('@kortix/ui/customize/sections/view/channels-view');

function renderEmail() {
  // A server render runs no query; the client only satisfies hooks this suite does not stub.
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <ChannelsSection projectId="email-test" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  canWrite = true;
  emailChannel = true;
  emailInstall.mockClear();
});

// Email (Resend Inboxes) is experimental behind the `email_channel` flag: on,
// it is a hero like every other Kortix channel; off, it is on no surface.
describe('ChannelsSection — Email', () => {
  test('flag off: no Email hero, and its install is never read', () => {
    emailChannel = false;
    const markup = renderEmail();
    expect(markup).not.toContain('Give your agent an inbox');
    expect(emailInstall).toHaveBeenCalledWith(null, 'kortix_email');
  });

  test("flag off: Email's own page is the standard flag-off screen", () => {
    emailChannel = false;
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <ChannelsSection projectId="email-test" platform="email" />
      </QueryClientProvider>,
    );
    expect(markup).toContain('Email channel');
    expect(markup).not.toContain('Give your agent an inbox');
  });

  test('flag on: the Email hero with Connect, and no Feature flags detour', () => {
    const markup = renderEmail();
    expect(markup).toContain('Give your agent an inbox');
    expect(markup).toContain('>Connect</button>');
    expect(markup).not.toContain('Feature flags');
    expect(emailInstall).toHaveBeenCalledWith('email-test', 'kortix_email');
  });

  test('read-only members still see Email, without a Connect they cannot use', () => {
    canWrite = false;
    const markup = renderEmail();
    expect(markup).toContain('Give your agent an inbox');
    expect(markup).not.toContain('>Connect</button>');
  });
});
