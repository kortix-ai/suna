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
// Every state update the shell makes. The static render ignores them, so they are recorded here.
const stateUpdates: unknown[] = [];
let inboxPrompts: Array<Record<string, unknown>> = [
  {
    prompt_id: 'row-1',
    client_message_id: 'start_row-1',
    text: 'first prompt',
    attachments: [],
    state: 'queued',
  },
];
const startSessionWithPrompt = mock(
  async (_projectId: string, _sessionId: string, input: { parts: Array<{ text?: string }> }) => {
    posted.push(input.parts[0]?.text ?? '');
    return { state: 'queued' };
  },
);
// Sends after the first are inbox rows, so they carry their queue placement.
const enqueue = mock(
  async (input: { parts: Array<{ text?: string }>; placement?: string }) => {
    posted.push(input.parts[0]?.text ?? '');
    return { state: 'queued' };
  },
);
const realSdkReact = await import('@kortix/sdk/react');
const realQueuedBubbles = await import('@/features/session/turn/queued-prompt-bubbles');
const realToast = await import('@/components/ui/toast');
const realReact = await import('react');
// Read before the mock: `mock.module` patches this namespace in place.
const realUseState = realReact.useState;
const passChildren = ({ children }: { children?: ReactNode }) => children;

mock.module('react', () => ({
  ...realReact,
  useState: <S,>(initial: S | (() => S)) => {
    const [value, setValue] = realUseState(initial);
    const record = (next: S | ((current: S) => S)) => {
      stateUpdates.push(next);
      setValue(next);
    };
    return [value, record] as const;
  },
}));
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
mock.module('@/features/session/turn/queued-prompt-bubbles', () => ({ ...realQueuedBubbles }));
mock.module('@/features/session/session-wallpaper-layer', () => ({
  useSessionWallpaperLayer: () => null,
}));
mock.module('@/features/session/session-welcome', () => ({ SessionWelcome: () => null }));
mock.module('@/features/workspace/project-layout/project-home', () => ({
  // Before the first send the hero composer renders inside the welcome body.
  ProjectHomeWelcomeBody: ({ composer }: { composer?: ReactNode }) => composer ?? null,
}));
mock.module('@/stores/kortix-computer-store', () => ({
  useKortixComputerStore: (select: (state: { openFileInComputer: () => void }) => unknown) =>
    select({ openFileInComputer: () => {} }),
}));
mock.module('@/lib/sounds', () => ({ playSound: () => {} }));
mock.module('@/i18n/use-translations', () => ({
  useTranslations: () => Object.assign((key: string) => key, { raw: (key: string) => key }),
}));
const errorToast = mock((_message: string, _options?: Record<string, unknown>) => {});
mock.module('@/components/ui/toast', () => ({ ...realToast, errorToast }));
mock.module('@kortix/sdk/react', () => ({
  ...realSdkReact,
  startSessionWithPrompt,
  usePromptAttachments: () => ({}),
  useRuntimeAgents: () => ({ data: [] }),
  useSessionPrompts: () => ({ prompts: inboxPrompts, enqueue }),
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
  resubmit: () => {},
  release: () => {},
});

beforeEach(() => {
  posted.length = 0;
  startSessionWithPrompt.mockClear();
  enqueue.mockClear();
  errorToast.mockClear();
  renderToStaticMarkup(
    createElement(InstantSessionShell, {
      projectId: 'project-1',
      sessionId: 'session-shell',
      stage: 'provisioning',
    }),
  );
});

test('the hidden boot shell releases draft ownership during handoff', () => {
  expect(composer.draftActive).toBe(true);
  renderToStaticMarkup(
    createElement(InstantSessionShell, {
      projectId: 'project-1',
      sessionId: 'session-shell',
      stage: 'provisioning',
      draftActive: false,
    }),
  );
  expect(composer.draftActive).toBe(false);
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
    resubmit: () => {},
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
  expect(enqueue.mock.calls.map(([input]) => input.placement)).toEqual([
    'transcript',
    'transcript',
    'transcript',
  ]);
});

function renderFirstSend(onSubmit: () => void) {
  inboxPrompts = [];
  try {
    renderToStaticMarkup(
      createElement(InstantSessionShell, {
        projectId: 'project-1',
        sessionId: 'session-shell-first',
        stage: 'provisioning',
        onSubmit,
      }),
    );
  } finally {
    inboxPrompts = [
      {
        prompt_id: 'row-1',
        client_message_id: 'start_row-1',
        text: 'first prompt',
        attachments: [],
        state: 'queued',
      },
    ];
  }
  stateUpdates.length = 0;
}

test('a refused first text-only send paints nothing, and the composer that sent it keeps the draft', async () => {
  const onSubmit = mock(() => {});
  renderFirstSend(onSubmit);
  let updatesAtPost: unknown[] | undefined;
  startSessionWithPrompt.mockImplementationOnce(async () => {
    updatesAtPost = [...stateUpdates];
    throw new Error('Forbidden');
  });

  await expect(
    Promise.resolve(composer.onSend('ask @[agent:writer]', undefined, {}, noUploads())),
  ).rejects.toThrow('Forbidden');

  // The hero composer stays mounted: no bubble before the POST, and no prefill afterwards,
  // which would bring its mention chips back as plain text.
  expect(updatesAtPost).toEqual([]);
  expect(stateUpdates).toEqual([]);
  expect(onSubmit).not.toHaveBeenCalled();
});

test('an accepted first text-only send paints after its POST', async () => {
  const onSubmit = mock(() => {});
  renderFirstSend(onSubmit);
  let updatesAtPost: unknown[] | undefined;
  startSessionWithPrompt.mockImplementationOnce(async () => {
    updatesAtPost = [...stateUpdates];
    return { state: 'queued' };
  });

  await Promise.resolve(composer.onSend('hello', undefined, {}, noUploads()));

  expect(updatesAtPost).toEqual([]);
  expect(stateUpdates).toEqual([{ text: 'hello', files: [] }]);
  expect(onSubmit).toHaveBeenCalledTimes(1);
});

test('a send made while a boot-shell text-only POST is in flight POSTs after that POST settles', async () => {
  let answerPost!: () => void;
  const answered = new Promise<void>((resolve) => {
    answerPost = resolve;
  });
  enqueue.mockImplementationOnce(async (input) => {
    posted.push(input.parts[0]?.text ?? '');
    await answered;
    return { state: 'queued' };
  });
  const ready: AttachmentSubmission = {
    submittedIds: ['upload-a'],
    readyAtSend: true,
    whenReady: async () => [imagePart],
    retry: () => {},
    resubmit: () => {},
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

/** The `extraSends` list the shell holds, replayed from its own state updates.
 *  It is the only functional `setState` the shell makes on a send path. */
function extraSendsNow(): Array<{ id: string }> {
  let list: Array<{ id: string }> = [];
  for (const update of stateUpdates) {
    if (typeof update !== 'function') continue;
    const next = (update as (prev: Array<{ id: string }>) => unknown)(list);
    if (Array.isArray(next)) list = next as Array<{ id: string }>;
  }
  return list;
}

const readyUpload = (): AttachmentSubmission => ({
  submittedIds: ['upload-a'],
  readyAtSend: true,
  whenReady: async () => [imagePart],
  retry: () => {},
  resubmit: () => {},
  release: () => {},
});

/**
 * A send delivered detached from the composer used to keep its local copy for
 * the rest of the shell's life. The copy was hidden only while the inbox still
 * listed the row — so a Remove un-hid it and redrew a bubble the "Removed from
 * queue" toast said was gone.
 */
test('a detached send drops its local copy once the server owns the row', async () => {
  stateUpdates.length = 0;

  await Promise.resolve(composer.onSend('with image', [imageFile], {}, readyUpload()));
  await settle();

  expect(posted).toEqual(['with image']);
  expect(extraSendsNow()).toEqual([]);
});

test('a detached send whose POST is refused keeps its local copy, marked failed', async () => {
  stateUpdates.length = 0;
  enqueue.mockImplementationOnce(async () => {
    throw new Error('Service Unavailable');
  });

  await Promise.resolve(composer.onSend('with image', [imageFile], {}, readyUpload()));
  await settle();

  // The row stays on screen with its Retry: nothing else can send it again.
  expect(extraSendsNow()).toHaveLength(1);
  expect((extraSendsNow()[0] as { uploadStatus?: { state: string } }).uploadStatus?.state).toBe(
    'failed',
  );
});

/**
 * One Enter, one sentence. A send keeps the SDK's transport error sink — that
 * is what opens the upgrade dialog on a 402 — so the shell's own sentence
 * beside it was two toasts for one refusal.
 */
test('a refused send the transport reported paints no second sentence', async () => {
  enqueue.mockImplementationOnce(async () => {
    throw Object.assign(new Error('Forbidden'), { status: 403 });
  });

  await expect(
    Promise.resolve(composer.onSend('blocked', undefined, {}, noUploads())),
  ).rejects.toThrow('Forbidden');

  expect(errorToast).not.toHaveBeenCalled();
});

test('a refusal that never reached the server still gets the shell’s sentence', async () => {
  enqueue.mockImplementationOnce(async () => {
    throw new Error('its earlier delivery already failed');
  });

  await expect(
    Promise.resolve(composer.onSend('blocked', undefined, {}, noUploads())),
  ).rejects.toThrow('its earlier delivery already failed');

  expect(errorToast).toHaveBeenCalledTimes(1);
});
