import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import { createElement, type ComponentProps, type ReactNode } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { ComposerChatInput } from '@/features/session/composer-chat-input';
import { useComposerPrefillStore } from '@/stores/composer-prefill-store';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let composer!: ComponentProps<typeof ComposerChatInput>;
mock.module('@/features/session/composer-chat-input', () => ({
  ComposerChatInput: (props: typeof composer) => {
    composer = props;
    return null;
  },
}));
mock.module('@/i18n/use-translations', () => ({
  useTranslations: () => ({ raw: () => 'Message' }),
}));
mock.module('@tanstack/react-query', () => ({ useQuery: () => ({ data: undefined }) }));
mock.module('@/lib/use-project-can', () => ({ useProjectCan: () => ({ allowed: false }) }));
mock.module('@/stores/account-panel-store', () => ({ hubTarget: () => null }));
mock.module('@kortix/sdk', () => ({
  getProjectDetail: mock(),
  listProjectAccessRequests: mock(),
  listProjectSandboxes: mock(),
}));
mock.module('@kortix/sdk/react', () => ({
  contract: () => ({}),
  qk: { project: { sandboxes: () => [], accessRequests: () => [], detail: () => [] } },
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
let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount());
  renderer = undefined;
  useComposerPrefillStore.setState({ prefillByProject: {} });
});

async function mount(onSend: ComponentProps<typeof ProjectHome>['onSend']) {
  const warning =
    'react-test-renderer is deprecated. See https://react.dev/warnings/react-test-renderer';
  const original = console.error;
  const warnings: unknown[][] = [];
  const capture = spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    if (args.length === 1 && args[0] === warning) warnings.push(args);
    else original(...args);
  });
  try {
    await act(async () => {
      renderer = create(
        createElement(ProjectHome, { projectId: 'project-1', onSend, busy: false }),
      );
    });
  } finally {
    capture.mockRestore();
    expect(warnings).toEqual([[warning]]);
  }
}

test('automatic prefill failure restores the consumed text for one explicit retry', async () => {
  const failure = new Error('Session creation failed');
  const onSend = mock(async () => {
    throw failure;
  });
  useComposerPrefillStore
    .getState()
    .setPrefill('project-1', 'onboarding prompt', { autoSend: true });
  await mount(onSend);
  expect(onSend).toHaveBeenCalledTimes(1);
  expect(onSend).toHaveBeenCalledWith('onboarding prompt', undefined, {}, []);
  expect(useComposerPrefillStore.getState().prefillByProject['project-1']).toBeUndefined();
  expect(composer.prefill?.text).toBe('onboarding prompt');
  // The regular composer must still observe the original rejection to restore its draft.
  await expect(composer.onSend('onboarding prompt', undefined, {}, [])).rejects.toBe(failure);
  expect(onSend).toHaveBeenCalledTimes(2);
});

test('slash-command failure preserves the command and options without an unhandled rejection', async () => {
  const failure = new Error('Session creation failed');
  const onSend = mock(async () => {
    throw failure;
  });
  await mount(onSend);
  await act(async () => {
    composer.onCommand?.({ name: 'plan', description: 'Plan', template: '', hints: [] }, 'retry this', {});
  });
  expect(onSend).toHaveBeenCalledWith('/plan retry this', undefined, {}, []);
  expect(composer.prefill?.text).toBe('/plan retry this');
  expect(onSend).toHaveBeenCalledTimes(1);
});

test('ordinary prefill does not send and successful automatic send does not restore a draft', async () => {
  const onSend = mock(async () => {});
  useComposerPrefillStore.getState().setPrefill('project-1', 'draft only');
  await mount(onSend);
  expect(onSend).not.toHaveBeenCalled();
  expect(composer.prefill?.text).toBe('draft only');
  await act(async () => {
    useComposerPrefillStore.getState().setPrefill('project-1', 'send now', { autoSend: true });
  });
  expect(onSend).toHaveBeenCalledTimes(1);
  expect(composer.prefill?.text).toBe('draft only');
});
