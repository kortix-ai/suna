import { afterEach, expect, mock, test } from 'bun:test';
import type { SessionPromptPart } from '@kortix/sdk';
import { createElement, type ComponentProps, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ComposerChatInput } from '@/features/session/composer-chat-input';
import type { FirstChat } from './home/first-chat';

let composer!: ComponentProps<typeof ComposerChatInput>;
let firstChat: ComponentProps<typeof FirstChat> | undefined;
let firstChatPending = false;
// `mock.module` is process-wide: every shared module keeps its real exports and
// overrides only what this test needs, so other suites in the same run still link.
const realComposerInput = await import('@/features/session/composer-chat-input');
const realTranslations = await import('@/i18n/use-translations');
const realQuery = await import('@tanstack/react-query');
const realProjectCan = await import('@/lib/use-project-can');
const realAccountPanel = await import('@/stores/account-panel-store');
const realSdk = await import('@kortix/sdk');
const realSdkReact = await import('@kortix/sdk/react');
const realFirstChatStore = await import('@/stores/first-chat-store');
mock.module('@/features/session/composer-chat-input', () => ({
  ...realComposerInput,
  ComposerChatInput: (props: typeof composer) => {
    composer = props;
    return null;
  },
}));
mock.module('@/i18n/use-translations', () => ({
  ...realTranslations,
  // Callable for the first chat's keys (`firstChat.placeholder`), `.raw` for
  // the home placeholder. Both return something a test can tell apart.
  useTranslations: (namespace: string) =>
    Object.assign((key: string) => `${namespace}.${key}`, { raw: () => 'Message' }),
}));
// Zustand hooks read the store's initial state under `renderToStaticMarkup`, so
// the pending flag is set here rather than through the store.
mock.module('@/stores/first-chat-store', () => ({
  ...realFirstChatStore,
  useFirstChatPending: () => firstChatPending,
}));
mock.module('@tanstack/react-query', () => ({
  ...realQuery,
  useQuery: () => ({ data: undefined }),
}));
mock.module('@/lib/use-project-can', () => ({
  ...realProjectCan,
  useProjectCan: () => ({ allowed: false }),
}));
mock.module('@/stores/account-panel-store', () => ({ ...realAccountPanel, hubTarget: () => null }));
mock.module('@kortix/sdk', () => ({
  ...realSdk,
  getProjectDetail: mock(),
  listProjectAccessRequests: mock(),
  listProjectSandboxes: mock(),
}));
mock.module('@kortix/sdk/react', () => ({
  ...realSdkReact,
  contract: () => ({}),
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
mock.module('@/features/workspace/project-layout/sidebar-toggle', () => ({
  SidebarToggle: () => null,
}));
mock.module('./home/access-requests-bell', () => ({ AccessRequestsBell: () => null }));
mock.module('./home/meta-runtime-indicator', () => ({ MetaRuntimeIndicator: () => null }));
mock.module('./home/sandbox-picker', () => ({ SandboxPicker: () => null }));
mock.module('./home/setup-tiles', () => ({ PROJECT_SETUP_TILE_ACTIONS: [] }));
mock.module('./home/first-chat', () => ({
  FirstChat: (props: ComponentProps<typeof FirstChat>) => {
    firstChat = props;
    return props.composer;
  },
}));
mock.module('./home/welcome-body', () => ({
  ProjectHomeWallpaper: () => null,
  ProjectHomeWelcomeBody: ({ composer: input }: { composer: ReactNode }) => input,
}));
const { ProjectHome } = await import('./project-home');

const handle: SessionPromptPart = {
  type: 'file',
  attachment_id: '11111111-1111-4111-8111-111111111111',
  filename: 'brief.pdf',
  mime: 'application/pdf',
};

function mount(onSend: ComponentProps<typeof ProjectHome>['onSend']) {
  firstChat = undefined;
  renderToStaticMarkup(createElement(ProjectHome, { projectId: 'project-1', onSend, busy: false }));
}

afterEach(() => {
  firstChatPending = false;
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

// Neither starter may call `onSend` itself. "Recommend tools" only fills the
// box; "Update memory" submits through the composer (`prefill.submit`), so the
// send carries the composer's agent and model and meets its refusals.
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
