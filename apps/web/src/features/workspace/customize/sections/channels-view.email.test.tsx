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
let inboxes: Array<Record<string, unknown>> = [];
const emailInboxes = mock((projectId: string | null) => ({ data: projectId ? inboxes : [], isLoading: false, refetch: mock() }));
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
  useDisconnectSlack: disconnect,
  useDisconnectEmail: disconnect,
  useConnectSlack: () => ({ isPending: false, mutate: mock(), mutateAsync: mock() }),
  useSlackManifest: () => ({ data: null }),
  // The rest of the module, for the connector pages this view's imports reach.
  useEmailInstall: disconnected,
  useEmailMode: disconnected,
  useConnectEmail: disconnect,
  useListEmailDomains: disconnect,
  useAddEmailDomain: disconnect,
  useVerifyEmailDomain: disconnect,
  useUpdateEmailPolicy: disconnect,
  useTelegramInstall: disconnected,
  useConnectTelegram: disconnect,
  useSetTelegramAllowedUsers: disconnect,
  useDisconnectTelegram: disconnect,
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
// Each inbox is an account on `kortix_email`; the hero reads them through these hooks.
mock.module('@kortix/ui/internal/hooks/channels/use-email-inboxes', () => ({
  useEmailInboxes: emailInboxes,
  useAddEmailInbox: disconnect,
  useUpdateEmailInbox: disconnect,
  useRemoveEmailInbox: disconnect,
}));
// The inbox form reads the server's email mode and domains: not this suite's subject.
mock.module('@kortix/ui/customize/sections/component/email-connect-form', () => ({
  EmailConnectForm: () => null,
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
  inboxes = [];
  emailInboxes.mockClear();
});

const inbox = (email: string) => ({
  connection_id: `conn-${email}`,
  inbox_id: `inbox-${email}`,
  email,
  label: email,
  owner_type: 'project',
  managed: true,
  created_by_kortix: true,
  is_default: false,
  sender_policy: { mode: 'allow_all', allowed_emails: [], allowed_domains: [], allowed_regex: null },
});

// Email (Resend Inboxes) is experimental behind the `email_channel` flag: on,
// it is a hero like every other Kortix channel; off, it is on no surface.
// Each inbox is an ACCOUNT on the `kortix_email` connector profile.
describe('ChannelsSection — Email', () => {
  test('flag off: no Email hero, and no inbox is read', () => {
    emailChannel = false;
    const markup = renderEmail();
    expect(markup).not.toContain('Give your agent an inbox');
    expect(emailInboxes).not.toHaveBeenCalled();
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

  test('flag on, no inbox yet: the hero offers Add an inbox, no Feature flags detour', () => {
    const markup = renderEmail();
    expect(markup).toContain('Give your agent an inbox');
    expect(markup).toContain('>Add an inbox</button>');
    expect(markup).not.toContain('Feature flags');
    expect(emailInboxes).toHaveBeenCalledWith('email-test');
  });

  test('two inboxes: the hero counts them, lists both, Manage opens the profile, Add another', () => {
    inboxes = [inbox('support@kortixmail.com'), inbox('sales@kortixmail.com')];
    const markup = renderEmail();
    expect(markup).toContain('2 inboxes');
    expect(markup).toContain('support@kortixmail.com, sales@kortixmail.com');
    expect(markup).toContain('/connectors/connected/kortix_email');
    expect(markup).toContain('Manage inboxes');
    expect(markup).toContain('>Add another inbox</button>');
  });

  test('read-only members still see Email, without an Add they cannot use', () => {
    canWrite = false;
    const markup = renderEmail();
    expect(markup).toContain('Give your agent an inbox');
    expect(markup).not.toContain('>Add an inbox</button>');
  });
});
