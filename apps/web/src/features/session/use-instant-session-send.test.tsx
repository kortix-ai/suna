/**
 * Characterization: the instant shell's four-source first-prompt submission
 * precedence (local submission / first-frame preview / durable row / start
 * stash), driven through the mounted shell.
 *
 * `apps/web` has no DOM harness. The shell renders once with
 * `renderToStaticMarkup`, so a state update a Send makes is replayed into a
 * second static render through the slot map in the `react` mock below.
 */
import { beforeEach, expect, mock, test } from 'bun:test';
import type { SessionPromptPart } from '@kortix/sdk';
import { createElement, type ComponentProps, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { ComposerChatInput } from '@/features/session/composer-chat-input';
import type { AttachmentSubmission } from '@/features/session/composer/attachment-submission';
import type { OptimisticTurn } from '@/features/session/optimistic-turn';
import { buildOptimisticPromptTextWithUploads } from '@/features/session/uploaded-file-refs';
import type { AttachedFile } from '@/features/session/session-chat-input';
import { resolveFirstPromptSubmission } from './use-instant-session-send';

type TurnProps = ComponentProps<typeof OptimisticTurn>;
const turns: TurnProps[] = [];
let composer!: ComponentProps<typeof ComposerChatInput>;
// One slot per `useState` call site, in render order. A Send's updates are
// recorded here and the next render initializes from them.
const stateBySlot = new Map<number, unknown>();
let slot = 0;
const stashes = new Map<
  string,
  { prompt: string; agent: string | null; model: null; variant: null }
>();
let inboxPrompts: Array<Record<string, unknown>> = [];
const posted: string[] = [];

const realReact = await import('react');
const realUseState = realReact.useState;
const realSdkReact = await import('@kortix/sdk/react');
const realQueuedBubbles = await import('@/features/session/turn/queued-prompt-bubbles');
const realToast = await import('@/components/ui/toast');
const passChildren = ({ children }: { children?: ReactNode }) => children;
// zustand reads hooks off the `default` export, so the server snapshot gets
// patched on both surfaces.
const clientSnapshotUseSyncExternalStore = <S,>(
  _subscribe: unknown,
  getSnapshot: () => S,
  getServerSnapshot?: () => S,
) => (getServerSnapshot ? getSnapshot() : getSnapshot());
const patchedReact = {
  ...realReact,
  default: { ...realReact.default, useSyncExternalStore: clientSnapshotUseSyncExternalStore },
  useSyncExternalStore: clientSnapshotUseSyncExternalStore,
};

mock.module('react', () => ({
  ...patchedReact,
  useState: <S,>(initial: S | (() => S)) => {
    const index = slot++;
    const [value, setValue] = realUseState(
      stateBySlot.has(index) ? (stateBySlot.get(index) as S) : initial,
    );
    const record = (next: S | ((current: S) => S)) => {
      const resolved = typeof next === 'function' ? (next as (current: S) => S)(value) : next;
      stateBySlot.set(index, resolved);
      setValue(resolved);
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
mock.module('@/features/session/optimistic-turn', () => ({
  OptimisticTurn: (props: TurnProps) => {
    turns.push(props);
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
mock.module('@/features/session/turn/queued-prompt-bubbles', () => ({ ...realQueuedBubbles }));
mock.module('@/features/session/session-wallpaper-layer', () => ({
  useSessionWallpaperLayer: () => null,
}));
mock.module('@/features/session/session-welcome', () => ({ SessionWelcome: () => null }));
mock.module('@/features/workspace/project-layout/project-home', () => ({
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
mock.module('@/components/ui/toast', () => ({ ...realToast, errorToast: mock() }));
const startSessionWithPrompt = mock(
  async (_projectId: string, _sessionId: string, input: { parts: Array<{ text?: string }> }) => {
    posted.push(input.parts[0]?.text ?? '');
    return { state: 'queued' };
  },
);
const enqueue = mock(
  async (input: { parts: Array<{ text?: string }> }) => {
    posted.push(input.parts[0]?.text ?? '');
    return { state: 'queued' };
  },
);
// The viewer: queued rows offer their actions to their author only.
mock.module('@/features/providers/auth-provider', () => ({ useAuth: () => ({ user: { id: 'user-1' } }) }));
mock.module('@kortix/sdk/react', () => ({
  ...realSdkReact,
  startSessionWithPrompt,
  useProjectSession: () => ({ data: undefined }),
  usePromptAttachments: () => ({}),
  useRuntimeAgents: () => ({ data: [] }),
  useFeatureFlag: () => ({ enabled: true, isLoading: false }),
  useSessionPrompts: () => ({ prompts: inboxPrompts, enqueue }),
  readStartStash: (sessionId: string) => stashes.get(sessionId) ?? null,
  writeStartStash: () => {},
}));

const { InstantSessionShell } = await import('./instant-session-shell');
const { useFirstPromptPreviewStore, usePendingFilesStore } = await import(
  '@/stores/session-composer-handoff-store'
);

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
const fileA: AttachedFile = {
  kind: 'local',
  uploadId: 'upload-a',
  file: new File(['a'], 'a.png', { type: 'image/png' }),
  localUrl: 'blob:a',
  isImage: true,
};
const fileB: AttachedFile = {
  kind: 'local',
  uploadId: 'upload-b',
  file: new File(['b'], 'b.png', { type: 'image/png' }),
  localUrl: 'blob:b',
  isImage: true,
};
const imagePart: SessionPromptPart = {
  type: 'file',
  attachment_id: '11111111-1111-4111-8111-111111111111',
  filename: 'a.png',
  mime: 'image/png',
};
// Uploads still in flight, so the first send paints detached from the composer.
const detachedSubmission = (): AttachmentSubmission => ({
  submittedIds: ['upload-a'],
  readyAtSend: false,
  whenReady: async () => [imagePart],
  retry: () => {},
  resubmit: () => {},
  release: () => {},
});

const firstRow = (extra: Record<string, unknown>): Array<Record<string, unknown>> => [
  { prompt_id: 'row-1', client_message_id: 'start_row-1', ...extra },
];

beforeEach(() => {
  turns.length = 0;
  posted.length = 0;
  stateBySlot.clear();
  stashes.clear();
  inboxPrompts = [];
  useFirstPromptPreviewStore.setState({ previewBySession: {} });
  usePendingFilesStore.setState({ files: [] });
  startSessionWithPrompt.mockClear();
  enqueue.mockClear();
});

function renderShell(sessionId = 'session-shell') {
  slot = 0;
  return renderToStaticMarkup(
    createElement(InstantSessionShell, {
      projectId: 'project-1',
      sessionId,
      stage: 'provisioning',
    }),
  );
}

test('a local first send wins text and files, and clears the tile names', async () => {
  renderShell('session-send');
  await Promise.resolve(composer.onSend('local send', [fileA], {}, detachedSubmission()));
  await settle();
  turns.length = 0;
  renderShell('session-send');
  expect(turns[0]?.text).toBe(buildOptimisticPromptTextWithUploads('local send', [fileA]));
  expect(turns[0]?.attachments).toEqual([]);
  expect(turns[0]?.uploadStatus).toBeUndefined();
});

test('the first-frame preview beats the durable row for text, files and upload status', () => {
  inboxPrompts = firstRow({
    text: 'row text',
    full_text: 'row full text',
    attachments: [{ filename: 'row.png', mime: 'image/png' }],
    state: 'failed',
    last_error: 'the box refused',
  });
  useFirstPromptPreviewStore
    .getState()
    .setFirstPromptPreview('session-preview', 'preview text', [fileA], {
      state: 'failed',
      message: 'upload refused',
    });
  renderShell('session-preview');
  expect(turns[0]?.text).toBe(buildOptimisticPromptTextWithUploads('preview text', [fileA]));
  expect(turns[0]?.attachments).toEqual([]);
  expect(turns[0]?.uploadStatus).toEqual({ state: 'failed', message: 'upload refused' });
});

test('the durable row carries the bubble when nothing else holds the first prompt', () => {
  inboxPrompts = firstRow({
    text: 'row text',
    full_text: 'row full text',
    attachments: [
      { filename: 'row.png', mime: 'image/png' },
      { filename: 'b.pdf', mime: 'application/pdf' },
    ],
    state: 'failed',
    last_error: 'the box refused',
  });
  renderShell('session-row');
  expect(turns[0]?.text).toBe('row full text');
  expect(turns[0]?.attachments).toEqual([
    { filename: 'row.png', mime: 'image/png' },
    { filename: 'b.pdf', mime: 'application/pdf' },
  ]);
  expect(turns[0]?.uploadStatus).toEqual({ state: 'failed', message: 'the box refused' });
});

test('the start stash is the last source: text from the stash, files from the pending store', () => {
  stashes.set('session-stash', { prompt: 'stashed prompt', agent: null, model: null, variant: null });
  usePendingFilesStore.setState({ files: [fileA, fileB] });
  renderShell('session-stash');
  expect(turns[0]?.text).toBe(buildOptimisticPromptTextWithUploads('stashed prompt', [fileA, fileB]));
  expect(turns[0]?.attachments).toEqual([]);
  expect(turns[0]?.uploadStatus).toBeUndefined();
});

test('a row with no text is still the first prompt: an attachment-only send', () => {
  inboxPrompts = firstRow({
    text: '',
    attachments: [{ filename: 'only.pdf', mime: 'application/pdf' }],
    state: 'queued',
  });
  renderShell('session-attachment-only');
  expect(turns[0]?.text).toBe('');
  expect(turns[0]?.attachments).toEqual([{ filename: 'only.pdf', mime: 'application/pdf' }]);
  expect(turns[0]?.uploadStatus).toBeUndefined();
});

/**
 * The extracted pure precedence itself: the same four sources, resolved
 * without mounting the shell.
 */
const rowSubmission = (extra: Record<string, unknown>) => ({
  text: 'row text',
  files: [],
  ...extra,
});

test('resolve: submission beats preview beats row beats stash for text', () => {
  const four = {
    submission: { text: 'submission text', files: [] },
    previewSubmission: { text: 'preview text', files: [] },
    pendingRowSubmission: rowSubmission({}),
    stashedSubmission: { text: 'stash text', files: [] },
    rememberedAttachments: undefined,
  };
  expect(resolveFirstPromptSubmission(four)?.text).toBe('submission text');
  expect(resolveFirstPromptSubmission({ ...four, submission: null })?.text).toBe('preview text');
  expect(
    resolveFirstPromptSubmission({ ...four, submission: null, previewSubmission: null })?.text,
  ).toBe('row text');
  expect(
    resolveFirstPromptSubmission({
      ...four,
      submission: null,
      previewSubmission: null,
      pendingRowSubmission: null,
    })?.text,
  ).toBe('stash text');
  expect(
    resolveFirstPromptSubmission({
      ...four,
      submission: null,
      previewSubmission: null,
      pendingRowSubmission: null,
      stashedSubmission: null,
    }),
  ).toBeNull();
});

test('resolve: files come from the first source that holds them', () => {
  const four = {
    submission: null,
    previewSubmission: null,
    pendingRowSubmission: rowSubmission({}),
    stashedSubmission: { text: 'stash text', files: [fileA, fileB] },
    rememberedAttachments: undefined,
  };
  expect(resolveFirstPromptSubmission(four)?.files).toEqual([fileA, fileB]);
  // Empty local files fall through to the next holder.
  expect(
    resolveFirstPromptSubmission({ ...four, submission: { text: 'empty', files: [] } })?.files,
  ).toEqual([fileA, fileB]);
  expect(
    resolveFirstPromptSubmission({ ...four, previewSubmission: { text: 'p', files: [fileB] } })
      ?.files,
  ).toEqual([fileB]);
  expect(
    resolveFirstPromptSubmission({
      ...four,
      submission: { text: 's', files: [fileA] },
      previewSubmission: { text: 'p', files: [fileB] },
    })?.files,
  ).toEqual([fileA]);
});

test('resolve: row attachment names are the fallback when this tab holds no bytes', () => {
  const attachments = [{ filename: 'row.png', mime: 'image/png' }];
  const resolved = resolveFirstPromptSubmission({
    submission: null,
    previewSubmission: null,
    pendingRowSubmission: rowSubmission({ attachments }),
    stashedSubmission: null,
    rememberedAttachments: undefined,
  });
  expect(resolved?.attachments).toEqual(attachments);
  // Local bytes clear the names instead of doubling them.
  expect(
    resolveFirstPromptSubmission({
      submission: { text: 's', files: [fileA] },
      previewSubmission: null,
      pendingRowSubmission: rowSubmission({ attachments }),
      stashedSubmission: null,
      rememberedAttachments: undefined,
    })?.attachments,
  ).toEqual([]);
});

test('resolve: remembered sent identities beat the row names', () => {
  const remembered = [{ id: 'upload-a', filename: 'a.png', mime: 'image/png' }];
  expect(
    resolveFirstPromptSubmission({
      submission: null,
      previewSubmission: null,
      pendingRowSubmission: rowSubmission({
        attachments: [{ filename: 'row.png', mime: 'image/png' }],
      }),
      stashedSubmission: null,
      rememberedAttachments: remembered,
    })?.attachments,
  ).toEqual(remembered);
});

test('resolve: upload status is the preview\'s, then the row\'s', () => {
  const four = {
    submission: null,
    previewSubmission: { text: 'p', files: [], uploadStatus: { state: 'failed' as const } },
    pendingRowSubmission: rowSubmission({ uploadStatus: { state: 'failed' as const } }),
    stashedSubmission: null,
    rememberedAttachments: undefined,
  };
  expect(resolveFirstPromptSubmission(four)?.uploadStatus).toEqual({ state: 'failed' });
  expect(
    resolveFirstPromptSubmission({ ...four, previewSubmission: null })?.uploadStatus,
  ).toEqual({ state: 'failed' });
  expect(
    resolveFirstPromptSubmission({
      ...four,
      previewSubmission: null,
      pendingRowSubmission: rowSubmission({}),
    })?.uploadStatus,
  ).toBeUndefined();
});
