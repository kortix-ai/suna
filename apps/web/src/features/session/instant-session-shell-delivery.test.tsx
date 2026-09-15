/**
 * The boot shell's sends, through the real `InstantSessionShell` send handler.
 *
 * `apps/web` has no DOM harness. The shell renders once with
 * `renderToStaticMarkup`, and the composer mock captures the `onSend` the shell
 * hands it. The session already holds its first prompt as a durable row, so
 * every send here is an extra send typed while the box boots.
 */
import { beforeEach, expect, mock, test } from 'bun:test';
import type { SessionPromptPart } from '@kortix/sdk';
import { createElement, type ComponentProps, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { ComposerChatInput } from '@/features/session/composer-chat-input';
import type { AttachmentSubmission } from '@/features/session/composer/attachment-submission';
import type { AttachedFile } from '@/features/session/session-chat-input';

let composer!: ComponentProps<typeof ComposerChatInput>;
const posted: string[] = [];
const startSessionWithPrompt = mock(
  async (_projectId: string, _sessionId: string, input: { parts: Array<{ text?: string }> }) => {
    posted.push(input.parts[0]?.text ?? '');
    return { state: 'queued' };
  },
);
const realSdkReact = await import('@kortix/sdk/react');
const realToast = await import('@/components/ui/toast');
const passChildren = ({ children }: { children?: ReactNode }) => children;

mock.module('@/features/session/composer-chat-input', () => ({
  ComposerChatInput: (props: typeof composer) => {
    composer = props;
    return null;
  },
}));
mock.module('@/features/session/session-layout', () => ({ SessionLayout: passChildren }));
mock.module('@/features/session/session-body', () => ({
  SESSION_TRANSCRIPT_CLASS: '',
  SessionBodyRow: passChildren,
}));
mock.module('@/features/session/header/session-site-header', () => ({
  SessionSiteHeader: () => null,
}));
mock.module('@/features/session/optimistic-turn', () => ({ OptimisticTurn: () => null }));
mock.module('@/features/session/turn/queued-prompt-bubbles', () => ({
  QueuedPromptBubbles: () => null,
}));
mock.module('@/features/session/session-wallpaper-layer', () => ({
  useSessionWallpaperLayer: () => null,
}));
mock.module('@/features/session/session-welcome', () => ({ SessionWelcome: () => null }));
mock.module('@/features/workspace/project-layout/project-home', () => ({
  ProjectHomeWelcomeBody: () => null,
}));
mock.module('@/stores/kortix-computer-store', () => ({
  useKortixComputerStore: (select: (state: { openFileInComputer: () => void }) => unknown) =>
    select({ openFileInComputer: () => {} }),
}));
mock.module('@/lib/sounds', () => ({ playSound: () => {} }));
mock.module('@/i18n/use-translations', () => ({
  useTranslations: () => Object.assign((key: string) => key, { raw: (key: string) => key }),
}));
mock.module('@/components/ui/toast', () => ({ ...realToast, errorToast: mock() }));
mock.module('@kortix/sdk/react', () => ({
  ...realSdkReact,
  startSessionWithPrompt,
  usePromptAttachments: () => ({}),
  useRuntimeAgents: () => ({ data: [] }),
  useSessionPrompts: () => ({
    prompts: [{ prompt_id: 'row-1', text: 'first prompt', attachments: [], state: 'queued' }],
  }),
  readStartStash: () => null,
  writeStartStash: () => {},
}));
const { InstantSessionShell } = await import('./instant-session-shell');

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
const imageFile: AttachedFile = {
  kind: 'local',
  uploadId: 'upload-a',
  file: new File(['a'], 'a.png', { type: 'image/png' }),
  localUrl: 'blob:a',
  isImage: true,
};
const imagePart: SessionPromptPart = {
  type: 'file',
  attachment_id: '11111111-1111-4111-8111-111111111111',
  filename: 'a.png',
  mime: 'image/png',
};
const noUploads = (): AttachmentSubmission => ({
  submittedIds: [],
  readyAtSend: true,
  whenReady: async () => [],
  retry: () => {},
  release: () => {},
});

beforeEach(() => {
  posted.length = 0;
  startSessionWithPrompt.mockClear();
  renderToStaticMarkup(
    createElement(InstantSessionShell, {
      projectId: 'project-1',
      sessionId: 'session-shell',
      stage: 'provisioning',
    }),
  );
});

test('boot-shell extra sends POST in Enter order', async () => {
  let finishUpload!: () => void;
  const uploaded = new Promise<void>((resolve) => {
    finishUpload = resolve;
  });
  const held: AttachmentSubmission = {
    submittedIds: ['upload-a'],
    readyAtSend: false,
    whenReady: async () => {
      await uploaded;
      return [imagePart];
    },
    retry: () => {},
    release: () => {},
  };

  // Enter 1: an image that is still uploading.
  await Promise.resolve(composer.onSend('with image', [imageFile], {}, held));
  // Enter 2 and 3: text only, typed while that upload runs. Each returns at once.
  const two = Promise.resolve(composer.onSend('text two', undefined, {}, noUploads()));
  const three = Promise.resolve(composer.onSend('text three', undefined, {}, noUploads()));
  await settle();
  expect(await Promise.race([Promise.all([two, three]).then(() => 'returned'), settle()])).toBe(
    'returned',
  );
  expect(posted).toEqual([]);

  finishUpload();
  await settle();
  expect(posted).toEqual(['with image', 'text two', 'text three']);
});

test('a send made while a boot-shell text-only POST is in flight POSTs after that POST settles', async () => {
  let answerPost!: () => void;
  const answered = new Promise<void>((resolve) => {
    answerPost = resolve;
  });
  startSessionWithPrompt.mockImplementationOnce(async (_projectId, _sessionId, input) => {
    posted.push(input.parts[0]?.text ?? '');
    await answered;
    return { state: 'queued' };
  });
  const ready: AttachmentSubmission = {
    submittedIds: ['upload-a'],
    readyAtSend: true,
    whenReady: async () => [imagePart],
    retry: () => {},
    release: () => {},
  };

  // A text-only send whose POST is still on the wire.
  const textSend = Promise.resolve(composer.onSend('text one', undefined, {}, noUploads()));
  // Another send of the same session meanwhile, its upload already finished.
  await Promise.resolve(composer.onSend('with image', [imageFile], {}, ready));
  await settle();
  expect(posted).toEqual(['text one']);

  answerPost();
  await textSend;
  await settle();
  expect(posted).toEqual(['text one', 'with image']);
});
