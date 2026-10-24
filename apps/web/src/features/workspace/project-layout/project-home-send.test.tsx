import { afterEach, expect, mock, test } from 'bun:test';
import type { SessionPromptPart } from '@kortix/sdk';
import { createElement, type ComponentProps, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ComposerChatInput } from '@kortix/ui/composer';
import type { FirstChat } from '@kortix/ui/workspace/home/first-chat';

let composer!: ComponentProps<typeof ComposerChatInput>;
let firstChat: ComponentProps<typeof FirstChat> | undefined;
let firstChatPending = false;
/** Whether the address carries `?chat=first` (the sidebar row, onboarding). */
let firstChatRequested = true;
/** `metadata.onboarding_completed_at` on the project detail; `null` = not onboarded. */
let onboardedAt: string | null = '2026-10-01T00:00:00Z';
/** The `project.write` probe: who may set the project up. */
let canWrite = true;
const stamp = mock(async () => ({}));
const replaced: string[] = [];
// `mock.module` is process-wide: every shared module keeps its real exports and
// overrides only what this test needs, so other suites in the same run still link.
const realComposerInput = await import('@kortix/ui/session/composer/composer-chat-input');
const realTranslations = await import('@/i18n/use-translations');
const realQuery = await import('@tanstack/react-query');
const realProjectCan = await import('@kortix/ui/internal/lib/use-project-can');
const realAccountPanel = await import('@kortix/ui/internal/stores/account-panel-store');
const realSdk = await import('@kortix/sdk');
const realSdkReact = await import('@kortix/sdk/react');
const realFirstChatStore = await import('@kortix/ui/internal/stores/first-chat-store');
const realUiProvider = { ...(await import('@kortix/ui/providers/ui-provider')) };
mock.module('@kortix/ui/providers/ui-provider', () => ({
  ...realUiProvider,
  useUiSearchParams: () => new URLSearchParams(firstChatRequested ? 'chat=first' : ''),
  useUiRouter: () => ({
    push: () => {},
    replace: (href: string) => replaced.push(href),
    prefetch: () => {},
    back: () => {},
  }),
}));
mock.module('@kortix/ui/session/composer/composer-chat-input', () => ({
  ...realComposerInput,
  ComposerChatInput: (props: typeof composer) => {
    composer = props;
    return null;
  },
}));
const translationsMock = () => ({
  ...realTranslations,
  // Callable for the first chat's keys (`firstChat.placeholder`), `.raw` for
  // the home placeholder. Both return something a test can tell apart.
  useTranslations: (namespace: string) =>
    Object.assign((key: string) => `${namespace}.${key}`, { raw: () => 'Message' }),
});
mock.module('@/i18n/use-translations', translationsMock);
mock.module('@kortix/ui/i18n', translationsMock);
// Zustand hooks read the store's initial state under `renderToStaticMarkup`, so
// the pending flag is set here rather than through the store.
mock.module('@kortix/ui/internal/stores/first-chat-store', () => ({
  ...realFirstChatStore,
  useFirstChatPending: () => firstChatPending,
}));
mock.module('@tanstack/react-query', () => ({
  ...realQuery,
  // One answer fits every query: the project detail (its metadata decides
  // onboarding), an empty sandbox list and no access requests.
  useQuery: () => ({
    isSuccess: true,
    data: {
      project: { account_id: 'a1', metadata: onboardedAt ? { onboarding_completed_at: onboardedAt } : {} },
      items: [],
      requests: [],
    },
  }),
  useQueryClient: () => new realQuery.QueryClient(),
}));
mock.module('@kortix/ui/internal/lib/use-project-can', () => ({
  ...realProjectCan,
  useProjectCan: (_projectId: string, action: string) => ({
    allowed: action === realSdk.PROJECT_ACTIONS.PROJECT_WRITE ? canWrite : false,
  }),
}));
mock.module('@kortix/ui/internal/stores/account-panel-store', () => ({ ...realAccountPanel, hubTarget: () => null }));
mock.module('@kortix/sdk', () => ({
  ...realSdk,
  getProjectDetail: mock(),
  listProjectAccessRequests: mock(),
  listProjectSandboxes: mock(),
  setProjectOnboardingComplete: stamp,
}));
mock.module('@kortix/sdk/react', () => ({
  ...realSdkReact,
  contract: () => ({}),
  invalidateProject: async () => {},
  qk: {
    ...realSdkReact.qk,
    project: {
      ...realSdkReact.qk.project,
      sandboxes: () => [],
      accessRequests: () => [],
      detail: () => [],
    },
  },
}));
mock.module('@kortix/ui/internal/layout/sidebar-toggle', () => ({
  SidebarToggle: () => null,
}));
mock.module('@kortix/ui/workspace/home/access-requests-bell', () => ({ AccessRequestsBell: () => null }));
mock.module('@kortix/ui/workspace/home/sandbox-picker', () => ({ SandboxPicker: () => null }));
mock.module('@kortix/ui/workspace/home/first-chat', () => ({
  FirstChat: (props: ComponentProps<typeof FirstChat>) => {
    firstChat = props;
    return props.composer;
  },
}));
mock.module('@kortix/ui/workspace/home/welcome-body', () => ({
  ProjectHomeWallpaper: () => null,
  ProjectHomeWelcomeBody: ({ composer: input }: { composer: ReactNode }) => input,
}));
const { ProjectHome } = await import('@kortix/ui/workspace/layout/project-home');

const handle: SessionPromptPart = {
  type: 'file',
  attachment_id: '11111111-1111-4111-8111-111111111111',
  filename: 'brief.pdf',
  mime: 'application/pdf',
};

function mount(onSend: ComponentProps<typeof ProjectHome>['onSend'], onboarding = false) {
  firstChat = undefined;
  renderToStaticMarkup(
    createElement(ProjectHome, { projectId: 'project-1', onSend, busy: false, onboarding }),
  );
}

afterEach(() => {
  firstChatRequested = true;
  firstChatPending = false;
  onboardedAt = '2026-10-01T00:00:00Z';
  canWrite = true;
  stamp.mockClear();
  replaced.length = 0;
});

test('composer Send forwards attachment handles and propagates a failed create', async () => {
  const failure = new Error('Session creation failed');
  const onSend = mock(async () => {
    throw failure;
  });
  mount(onSend);

  const attachments = {
    submittedIds: ['local-1'],
    readyAtSend: true,
    whenReady: async () => [handle],
    retry: () => {},
    resubmit: () => {},
    release: () => {},
  };
  // The composer keeps its selection only when it observes the rejection.
  await expect(composer.onSend('read this', undefined, {}, attachments)).rejects.toBe(failure);
  expect(onSend).toHaveBeenCalledWith('read this', undefined, {}, attachments);
});

test('a slash command whose send fails leaves no unhandled rejection', async () => {
  const unhandled: unknown[] = [];
  const record = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', record);
  try {
    const onSend = mock(async () => {
      throw new Error('Session creation failed');
    });
    mount(onSend);
    composer.onCommand?.({ name: 'plan', description: 'Plan', template: '', hints: [] }, 'x', {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onSend).toHaveBeenCalledWith('/plan x', undefined, {}, undefined);
    expect(unhandled).toEqual([]);
  } finally {
    process.off('unhandledRejection', record);
  }
});

test('a project without a first chat opens on the usual home and hero composer', () => {
  mount(mock(async () => {}));

  expect(firstChat).toBeUndefined();
  expect(composer.placeholder).toBe('Message');
  expect(composer.underbarPlacement).toBe('inline');
  expect(composer.slashMenuPlacement).toBe('below');
});

test('a pending first chat docks the composer under the welcome', () => {
  firstChatPending = true;
  mount(mock(async () => {}));

  expect(firstChat).toBeDefined();
  expect(composer.placeholder).toBe('firstChat.placeholder');
  expect(composer.underbarPlacement).toBe('below');
  expect(composer.slashMenuPlacement).toBe('above');
});

// "New session" opens plain project home. The first chat stays pending, but
// without `?chat=first` the page is the usual home, never the welcome again.
test('a pending first chat does not open without the explicit link', () => {
  firstChatPending = true;
  firstChatRequested = false;
  mount(mock(async () => {}));

  expect(firstChat).toBeUndefined();
  expect(composer.placeholder).toBe('Message');
});

// Neither starter may call `onSend` itself. Both submit through the composer
// (`prefill.submit`), so each send carries the composer's agent and model and
// meets its refusals.
test('neither starter sends around the composer', async () => {
  firstChatPending = true;
  const onSend = mock(async () => {});
  mount(onSend);

  firstChat!.onRecommendTools();
  firstChat!.onUpdateMemory();
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(onSend).not.toHaveBeenCalled();
});

test('a failed first-chat send still reaches the composer as a rejection', async () => {
  firstChatPending = true;
  const failure = new Error('Account cannot start a session');
  mount(
    mock(async () => {
      throw failure;
    }),
  );

  await expect(composer.onSend('hello', undefined, {})).rejects.toBe(failure);
});

// Onboarding (Kortix web passes `onboarding`): a project that is not onboarded
// opens on the first chat — welcome, starters, the sidebar row — and its
// composer holds "Onboard me" until a model is usable.
test('a project that is not onboarded opens on the first chat, even without the link', () => {
  onboardedAt = null;
  firstChatRequested = false;
  mount(mock(async () => {}), true);

  expect(firstChat).toBeDefined();
  expect(composer.placeholder).toBe('firstChat.placeholder');
  expect(composer.underbarPlacement).toBe('below');
});

test('a member who cannot set the project up never gets the onboarding', () => {
  onboardedAt = null;
  firstChatRequested = false;
  canWrite = false;
  mount(mock(async () => {}), true);

  expect(firstChat).toBeUndefined();
});

// A white-label or SDK host renders the same home without the prop.
test('a host that does not opt in keeps the usual home on an unstamped project', () => {
  onboardedAt = null;
  firstChatRequested = false;
  mount(mock(async () => {}), false);

  expect(firstChat).toBeUndefined();
});

test('the first send stamps the project onboarded once the session is created', async () => {
  onboardedAt = null;
  const onSend = mock(async () => {});
  mount(onSend, true);

  await composer.onSend('Onboard me', undefined, {});
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(onSend).toHaveBeenCalledWith('Onboard me', undefined, {}, undefined);
  expect(stamp).toHaveBeenCalledWith('project-1', true);
});

test('a refused first send leaves the project unstamped', async () => {
  onboardedAt = null;
  const failure = new Error('Account cannot start a session');
  mount(
    mock(async () => {
      throw failure;
    }),
    true,
  );

  await expect(composer.onSend('Onboard me', undefined, {})).rejects.toBe(failure);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(stamp).not.toHaveBeenCalled();
});

test('a send from an onboarded project stamps nothing', async () => {
  mount(mock(async () => {}), true);

  await composer.onSend('hello', undefined, {});
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(stamp).not.toHaveBeenCalled();
});
