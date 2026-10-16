import * as sdkReact from '@kortix/sdk/react';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act, useState } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import {
  initialDraft,
  type ComposerDraft,
} from '../../components/projects/schedule/trigger-composer-logic';
const { flattenModels, modelProviderMode, agentScopedModelSelectionKey } = sdkReact;
const win = new Window({ url: 'http://localhost:3000' });
Object.assign(globalThis, {
  window: win,
  document: win.document,
  localStorage: win.localStorage,
  navigator: win.navigator,
});
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

// Only runtime/network/store collaborators are replaced. Catalog normalization,
// flattening, grouping, visibility and ModelSelector itself execute unchanged.
let gateway = true;
const selected = mock();
const save = mock();
const models = {
  'anthropic/claude-test': {
    name: 'Fixture Claude',
    provider: 'anthropic',
    enabled: true,
    free: true,
  },
  auto: { name: 'Stale Auto', enabled: true },
  'kortix/auto': { name: 'Stale Namespaced Auto', enabled: true },
  disabled: { name: 'Disabled Fixture', enabled: false },
};
const providers = () => ({
  all: [
    { id: 'kortix', name: 'Kortix', models, source: 'api' },
    {
      id: 'anthropic',
      name: 'Anthropic',
      source: 'api',
      models: {
        'claude-native': { name: 'Native Claude', enabled: true },
        auto: { name: 'Stale Native Auto', enabled: true },
      },
    },
    {
      id: 'disconnected',
      name: 'Disconnected',
      models: { hidden: { name: 'Disconnected Fixture' } },
    },
  ],
  connected: gateway ? ['kortix', 'anthropic'] : ['anthropic'],
  default: {},
});
const store = {
  isVisible: () => true,
  getSessionAgentName: () => 'worker',
  getSelectedModel: () => null,
  setSelectedModel: selected,
  pushRecent: mock(),
  getRecent: () => [],
};
mock.module('@kortix/sdk/react', () => ({
  ...sdkReact,
  flattenModels,
  modelProviderMode,
  agentScopedModelSelectionKey,
  useRuntimeProviders: () => ({ data: providers() }),
  useFeatureFlag: (_id: unknown, key: string) => ({
    enabled: key === 'llm_gateway' && gateway,
    isLoading: false,
  }),
  useKortixRouteProjectId: () => 'fixture',
  useModelAccess: () => ({ data: {} }),
  useModelStore: () => store,
  useVisibleAgents: () => [{ name: 'worker' }],
  useModelDefaults: () => ({
    agentDefaults: {},
    resolveDefaultFor: () => null,
    setAgentDefault: selected,
    clearAgentDefault: mock(),
  }),
  useCreateRuntimeSession: () => ({}),
  useCreatePty: () => ({}),
  useProjectSessions: () => ({ sessions: [] }),
}));
mock.module('@tanstack/react-query', () => ({
  useQuery: ({ queryKey }: { queryKey: string[] }) => ({
    isPending: false,
    fetchStatus: 'idle',
    data: JSON.stringify(queryKey).includes('detail')
      ? { project: { experimental: { llm_gateway: gateway } } }
      : undefined,
  }),
  useQueries: () => [],
  useMutation: () => ({ mutate: save }),
  useQueryClient: () => ({ getQueryData: () => undefined }),
}));
mock.module('next/navigation', () => ({
  useParams: () => ({ id: 'fixture', sessionId: 'session' }),
  usePathname: () => '/projects/fixture/sessions/session',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: mock(), replace: mock(), prefetch: mock() }),
}));
mock.module('@/lib/use-project-can', () => ({
  useProjectCan: () => ({ allowed: true }),
  useProjectPageCans: () => ({}),
}));
mock.module('@/hooks/billing', () => ({
  useAccountState: () => ({ data: {}, isPending: false, fetchStatus: 'idle' }),
}));
mock.module('./session-chat-input', () => ({ AgentSelector: () => null }));
mock.module('@/features/providers/chatgpt-accounts-dialog', () => ({
  ChatGptAccountsDialog: () => null,
}));
// cmdk/Radix need a browser layout engine. Render their slots as host nodes;
// keep all selector rows, names, filters, event handlers and state real.
const Slot = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
mock.module('@/components/ui/command', () => ({
  CommandPopover: Slot,
  CommandPopoverContent: Slot,
  CommandPopoverTrigger: Slot,
  CommandGroup: Slot,
  CommandList: Slot,
  CommandSeparator: () => null,
  CommandItem: ({
    children,
    onSelect,
    value,
  }: {
    children?: React.ReactNode;
    onSelect?: () => void;
    value?: string;
  }) => (
    <button data-choice={value} onClick={onSelect}>
      {children}
    </button>
  ),
  CommandInput: () => null,
  CommandDialog: Slot,
  CommandFooter: Slot,
  CommandShortcut: Slot,
}));
mock.module('@/components/ui/select', () =>
  Object.fromEntries(
    ['Select', 'SelectContent', 'SelectItem', 'SelectTrigger', 'SelectValue'].map((key) => [
      key,
      Slot,
    ]),
  ),
);
mock.module('@/components/ui/slider', () => ({ Slider: () => null }));
mock.module('@/components/ui/hint', () => ({ default: Slot }));
mock.module('@/components/ui/toast', () => ({
  progressToast: mock(),
  dismissToast: mock(),
  loadingToast: mock(),
  successToast: mock(),
  errorToast: mock(),
  infoToast: mock(),
  warningToast: mock(),
}));

mock.module('@/hooks/channels/use-channels-installations', () => ({
  useSlackInstall: () => ({ data: { workspaceName: 'Fixture Workspace', workspaceId: 'W1' } }),
  useSlackMode: () => ({ data: null }),
  useEmailInstall: () => ({ data: null }),
  useDisconnectSlack: () => ({}),
  useDisconnectEmail: () => ({}),
}));
mock.module('@/hooks/channels/use-teams-installations', () => ({
  useTeamsInstall: () => ({ data: null }),
  useTeamsMode: () => ({ data: null }),
  // `teams-byo-wizard` reads both; a mock without them makes the import fail
  // with a missing-export error.
  useTeamsManifest: () => ({ data: null }),
  useConnectTeams: () => ({ mutate: () => {}, isPending: false }),
  useDisconnectTeams: () => ({}),
}));
mock.module('@/hooks/channels/use-channel-bindings', () => ({
  useChannelBindings: () => ({
    data: {
      bindings: [
        {
          bindingId: 'b1',
          platform: 'slack',
          channelId: 'C1',
          channelName: 'Fixture Conversation',
          conversationPolicy: 'project_open',
          agentName: null,
          opencodeModel: null,
          effectiveModel: { source: 'project', model: null },
          metadata: {},
        },
      ],
    },
  }),
  useUpdateChannelBinding: () => ({ mutate: save }),
}));
mock.module('@/features/workspace/customize/sections/component/slack-connect-card', () => ({
  SlackConnectCard: () => null,
}));
mock.module('@/features/workspace/customize/sections/teams-channel-panel', () => ({
  TeamsChannelPanel: () => null,
}));
mock.module('@/features/workspace/customize/sections/connectors-view', () => ({
  EmailConnectForm: () => null,
}));
mock.module('@/components/ui/alert-dialog', () =>
  Object.fromEntries(
    [
      'AlertDialog',
      'AlertDialogAction',
      'AlertDialogCancel',
      'AlertDialogContent',
      'AlertDialogDescription',
      'AlertDialogFooter',
      'AlertDialogHeader',
      'AlertDialogTitle',
    ].map((key) => [key, Slot]),
  ),
);
mock.module('@/features/providers/auth-provider', () => ({
  useAuth: () => ({ user: { id: 'user' } }),
}));
mock.module('@/hooks/account/use-accounts-list', () => ({ useAccountsList: () => ({ data: [] }) }));
mock.module('@/lib/use-project-feature-flags', () => ({
  useProjectFeatureFlags: () => ({ flags: {} }),
}));
mock.module('@/hooks/projects/use-new-project-session', () => ({
  useNewProjectSession: () => mock(),
}));
mock.module('next-themes', () => ({ useTheme: () => ({ theme: 'light', setTheme: mock() }) }));
mock.module('@/components/ui/modal', () => ({
  Modal: Slot,
  ModalContent: Slot,
  ModalHeader: Slot,
  ModalTitle: Slot,
  ModalDescription: Slot,
  ModalBody: Slot,
  ModalFooter: Slot,
}));

mock.module('@/features/project-files/components/change-request-detail-dialog', () => ({
  ChangeRequestDetailDialog: () => null,
}));
mock.module('@/features/session/diff-dialog', () => ({ DiffDialog: () => null }));
mock.module('@/features/session/header/compact-modal', () => ({ CompactModal: () => null }));
const { ModelSelector } = await import('./model-selector');
const { CommandPalette } = await import('../workspace/command-palette');
const { ChannelsSection } = await import('../workspace/customize/sections/view/channels-view');
const { ThenFields } = await import('../../components/projects/schedule/then-fields');
const { ModelSection } =
  await import('../workspace/customize/sections/view/agent-editor-basics-fields');
const { AgentModel } = await import('../workspace/capabilities/agents/agent-detail-aside');
let renderer: ReactTestRenderer;
afterEach(async () => {
  if (renderer) await act(() => renderer.unmount());
  selected.mockClear();
  save.mockClear();
});
async function mount(element: React.ReactElement) {
  await act(() => {
    renderer = create(element);
  });
}
function text(n: import('react-test-renderer').ReactTestInstance): string {
  return n
    .findAll((n) => typeof n.type === 'string')
    .map((n) => n.children.filter((c) => typeof c === 'string').join(''))
    .join(' ');
}
async function checkChoice() {
  const rows = renderer.root
    .findAllByType('button')
    .filter(
      (n) =>
        n.props['data-choice'] &&
        (n.props['data-choice'].includes(gateway ? 'anthropic/claude-test' : 'claude-native') ||
          text(n).includes(gateway ? 'Fixture Claude' : 'Native Claude')),
    );
  expect(rows.length).toBe(1);
  // The consumer supplies the real SDK capability semantics to the selector:
  // silence is not an explicit no-image claim, and only true earns Free.
  const selector = renderer.root.findAllByType(ModelSelector)[0];
  if (selector) {
    const offered = selector.props.models.find(
      (m: { modelName: string }) => m.modelName === (gateway ? 'Fixture Claude' : 'Native Claude'),
    );
    expect(offered.capabilities.vision).toBeUndefined();
    expect(offered.free).toBe(gateway);
  }
  const markup = JSON.stringify(renderer.toJSON());
  expect(markup).not.toContain('Stale');
  expect(markup).not.toContain('Disabled Fixture');
  expect(markup).not.toContain('Disconnected Fixture');
  expect(markup).not.toContain(gateway ? 'Native Claude' : 'Fixture Claude');
  await act(() => rows[0].props.onClick());
}
for (const mode of ['gateway', 'native'] as const)
  describe(`${mode} catalog in actual consumers`, () => {
    test('schedule choices patch the selected model', async () => {
      gateway = mode === 'gateway';
      function ScheduleDraft() {
        const [draft, setDraft] = useState<ComposerDraft>(() => initialDraft({}));
        return (
          <ThenFields
            agents={[]}
            draft={draft}
            payloadSchema={null}
            patch={(patch) => {
              selected(patch);
              setDraft((previous) => ({ ...previous, ...patch }));
            }}
          />
        );
      }
      await mount(<ScheduleDraft />);
      await checkChoice();
      const trigger = renderer.root
        .findAllByType('button')
        .find(
          (button) =>
            !button.props['data-choice'] &&
            text(button).includes(gateway ? 'Fixture Claude' : 'Native Claude'),
        );
      expect(trigger).toBeDefined();
      if (!trigger) throw new Error('Selected model label did not read back');
      expect(text(trigger)).not.toContain("Agent's usual model");
      expect(selected).toHaveBeenCalledWith({
        model: {
          providerID: gateway ? 'kortix' : 'anthropic',
          modelID: gateway ? 'anthropic/claude-test' : 'claude-native',
        },
      });
    });
    test('agent editor choices persist the wire model', async () => {
      gateway = mode === 'gateway';
      await mount(<ModelSection oc={{}} setOc={selected} showPrompt={false} />);
      await checkChoice();
      expect(selected).toHaveBeenCalledWith(
        'model',
        gateway ? 'anthropic/claude-test' : 'anthropic/claude-native',
      );
    });
    test('command palette choices write the scoped session selection', async () => {
      gateway = mode === 'gateway';
      await mount(<CommandPalette />);
      await act(() => win.dispatchEvent(new win.Event('kortix:open-command-palette')));
      const change = renderer.root
        .findAllByType('button')
        .find((n) => n.props['data-choice'] === 'suggestion change model llm switch');
      expect(change).toBeDefined();
      if (!change) throw new Error('Change Model choice missing');
      await act(() => change.props.onClick());
      await checkChoice();
      expect(selected).toHaveBeenCalledWith(agentScopedModelSelectionKey(mode, 'worker'), {
        providerID: gateway ? 'kortix' : 'anthropic',
        modelID: gateway ? 'anthropic/claude-test' : 'claude-native',
      });
    });
    test('channel settings choices save the wire model', async () => {
      gateway = mode === 'gateway';
      await mount(<ChannelsSection projectId="fixture" />);
      const channels = renderer.root
        .findAllByType('button')
        .find((n) => text(n).includes('channel'));
      expect(channels).toBeDefined();
      if (!channels) throw new Error('Channels button missing');
      await act(() => channels.props.onClick());
      const row = renderer.root
        .findAll(
          (n) => typeof n.props.onClick === 'function' && text(n).includes('Fixture Conversation'),
        )
        .at(-1);
      expect(row).toBeDefined();
      if (!row) throw new Error('Conversation row missing');
      await act(() => row.props.onClick());
      await checkChoice();
      const form = renderer.root.findByType('form');
      await act(() => form.props.onSubmit({ preventDefault() {} }));
      expect(save.mock.calls[0][0]).toMatchObject({
        projectId: 'fixture',
        bindingId: 'b1',
        opencodeModel: gateway ? 'anthropic/claude-test' : 'anthropic/claude-native',
      });
    });
    test('legacy agent defaults offer gateway choices or hide for native', async () => {
      gateway = mode === 'gateway';
      await mount(<AgentModel projectId="fixture" agentName="worker" />);
      if (!gateway) {
        expect(renderer.toJSON()).toBeNull();
        return;
      }
      await checkChoice();
      expect(selected).toHaveBeenCalledWith('worker', {
        providerID: 'kortix',
        modelID: 'anthropic/claude-test',
      });
    });
  });
