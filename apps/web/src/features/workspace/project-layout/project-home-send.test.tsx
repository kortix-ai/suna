import { expect, mock, test } from 'bun:test';
import type { SessionPromptPart } from '@kortix/sdk';
import { createElement, type ComponentProps, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ComposerChatInput } from '@/features/session/composer-chat-input';

let composer!: ComponentProps<typeof ComposerChatInput>;
// `mock.module` is process-wide: every shared module keeps its real exports and
// overrides only what this test needs, so other suites in the same run still link.
const realComposerInput = await import('@/features/session/composer-chat-input');
const realTranslations = await import('@/i18n/use-translations');
const realQuery = await import('@tanstack/react-query');
const realProjectCan = await import('@/lib/use-project-can');
const realAccountPanel = await import('@/stores/account-panel-store');
const realSdk = await import('@kortix/sdk');
const realSdkReact = await import('@kortix/sdk/react');
mock.module('@/features/session/composer-chat-input', () => ({
  ...realComposerInput,
  ComposerChatInput: (props: typeof composer) => {
    composer = props;
    return null;
  },
}));
mock.module('@/i18n/use-translations', () => ({
  ...realTranslations,
  useTranslations: () => ({ raw: () => 'Message' }),
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
  renderToStaticMarkup(createElement(ProjectHome, { projectId: 'project-1', onSend, busy: false }));
}

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
