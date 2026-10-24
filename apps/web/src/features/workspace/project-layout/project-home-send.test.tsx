import { afterEach, expect, mock, test } from 'bun:test';
import type { SessionPromptPart } from '@kortix/sdk';
import { createElement, type ComponentProps, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ComposerChatInput } from '@kortix/ui/composer';

let composer!: ComponentProps<typeof ComposerChatInput>;
/** `metadata.onboarding_completed_at` on the project detail; `null` = not onboarded. */
let onboardedAt: string | null = '2026-10-01T00:00:00Z';
/** The `project.write` probe: who may set the project up. */
let canWrite = true;
const stamp = mock(async () => ({}));
// `mock.module` is process-wide: every shared module keeps its real exports and
// overrides only what this test needs, so other suites in the same run still link.
const realComposerInput = await import('@kortix/ui/session/composer/composer-chat-input');
const realTranslations = await import('@/i18n/use-translations');
const realQuery = await import('@tanstack/react-query');
const realProjectCan = await import('@kortix/ui/internal/lib/use-project-can');
const realAccountPanel = await import('@kortix/ui/internal/stores/account-panel-store');
const realSdk = await import('@kortix/sdk');
const realSdkReact = await import('@kortix/sdk/react');
mock.module('@kortix/ui/session/composer/composer-chat-input', () => ({
  ...realComposerInput,
  ComposerChatInput: (props: typeof composer) => {
    composer = props;
    return null;
  },
}));
const translationsMock = () => ({
  ...realTranslations,
  // Callable for the onboarding chat's keys (`onboardingChat.placeholder`),
  // `.raw` for the home placeholder. Both return something a test can tell apart.
  useTranslations: (namespace: string) =>
    Object.assign((key: string) => `${namespace}.${key}`, { raw: () => 'Message' }),
});
mock.module('@/i18n/use-translations', translationsMock);
mock.module('@kortix/ui/i18n', translationsMock);
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

function mount(onSend: ComponentProps<typeof ProjectHome>['onSend'], onboarding = true) {
  renderToStaticMarkup(
    createElement(ProjectHome, { projectId: 'project-1', onSend, busy: false, onboarding }),
  );
}

afterEach(() => {
  onboardedAt = '2026-10-01T00:00:00Z';
  canWrite = true;
  stamp.mockClear();
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

test('an onboarded project opens on the usual home and hero composer', () => {
  mount(mock(async () => {}));

  expect(composer.placeholder).toBe('Message');
  expect(composer.underbarPlacement).toBe('inline');
  expect(composer.slashMenuPlacement).toBe('below');
});

test('a project that is not onboarded opens as a chat with the composer docked', () => {
  onboardedAt = null;
  mount(mock(async () => {}));

  expect(composer.placeholder).toBe('onboardingChat.placeholder');
  expect(composer.underbarPlacement).toBe('below');
  expect(composer.slashMenuPlacement).toBe('above');
});

// A member who cannot write the project cannot stamp it, so the onboarding
// chat would come back on every load. They see the usual home.
test('a member who cannot set the project up never gets the onboarding chat', () => {
  onboardedAt = null;
  canWrite = false;
  mount(mock(async () => {}));

  expect(composer.placeholder).toBe('Message');
});

// A white-label or SDK host renders the same home without the prop: its
// first run is its own, so an unstamped project shows the usual home.
test('a host that does not opt in never gets the onboarding chat', () => {
  onboardedAt = null;
  mount(mock(async () => {}), false);

  expect(composer.placeholder).toBe('Message');
});

test('the kickoff send stamps the project onboarded once the session is created', async () => {
  onboardedAt = null;
  const onSend = mock(async () => {});
  mount(onSend);

  await composer.onSend('Onboard me', undefined, {});
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(onSend).toHaveBeenCalledWith('Onboard me', undefined, {}, undefined);
  expect(stamp).toHaveBeenCalledWith('project-1', true);
});

test('a refused kickoff leaves the project unstamped and reaches the composer', async () => {
  onboardedAt = null;
  const failure = new Error('Account cannot start a session');
  mount(
    mock(async () => {
      throw failure;
    }),
  );

  await expect(composer.onSend('Onboard me', undefined, {})).rejects.toBe(failure);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(stamp).not.toHaveBeenCalled();
});

test('a send from an onboarded project stamps nothing', async () => {
  mount(mock(async () => {}));

  await composer.onSend('hello', undefined, {});
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(stamp).not.toHaveBeenCalled();
});
