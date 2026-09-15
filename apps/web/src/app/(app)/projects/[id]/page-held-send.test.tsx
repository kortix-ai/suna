import { beforeEach, expect, mock, test } from 'bun:test';
import {
  configureKortix,
  createPromptAttachmentController,
  type SessionPromptPart,
} from '@kortix/sdk';
import { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  captureAttachmentSubmission,
  deliverAfterPaint,
  type AttachmentSubmission,
} from '@/features/session/composer/attachment-submission';
import type { AttachedFile } from '@/features/session/session-chat-input';
import type { ProjectHome } from '@/features/workspace/project-layout/project-home';
import type { NewProjectSessionOpts } from '@/hooks/projects/use-new-project-session';

let home!: ComponentProps<typeof ProjectHome>;
const newSession = mock((_options: NewProjectSessionOpts) => {});
const startSessionWithPrompt = mock(async (..._args: unknown[]) => ({ state: 'queued' }));
const realQuery = await import('@tanstack/react-query');
const realToast = await import('@/components/ui/toast');
const realConfig = await import('@/lib/config');
const realSdkReact = await import('@kortix/sdk/react');

mock.module('@/features/workspace/project-layout/project-home', () => ({
  ProjectHome: (props: typeof home) => {
    home = props;
    return null;
  },
}));
mock.module('@/hooks/projects/use-new-project-session', () => ({
  useNewProjectSession: () => newSession,
}));
mock.module('@/hooks/projects/use-project-can-run', () => ({
  useProjectCanRun: () => ({ canRun: true, isLoading: false }),
}));
mock.module('@/hooks/billing', () => ({ useAccountState: () => ({ data: undefined }) }));
mock.module('@/lib/config', () => ({ ...realConfig, isBillingEnabled: () => false }));
mock.module('@/i18n/use-translations', () => ({
  useTranslations: () => Object.assign((key: string) => key, { raw: (key: string) => key }),
}));
mock.module('@/components/ui/toast', () => ({ ...realToast, errorToast: mock() }));
mock.module('@tanstack/react-query', () => ({
  ...realQuery,
  useQuery: () => ({ data: undefined }),
}));
mock.module('@kortix/sdk/react', () => ({ ...realSdkReact, startSessionWithPrompt }));
mock.module('next/navigation', () => ({
  useParams: () => ({ id: 'project-1' }),
  usePathname: () => '/projects/project-1',
  useRouter: () => ({ push: mock(), replace: mock(), prefetch: mock() }),
  useSearchParams: () => new URLSearchParams(),
}));
const { default: ProjectIndexPage } = await import('./page');
const { useFirstPromptPreviewStore } = await import('@/stores/session-composer-handoff-store');

const metadata = {
  attachment_id: '11111111-1111-4111-8111-111111111111',
  filename: 'brief.pdf',
  mime: 'application/pdf',
  size: 5,
  expires_at: '2099-01-01T00:00:00Z',
};
const filePart: SessionPromptPart = {
  type: 'file',
  attachment_id: metadata.attachment_id,
  filename: 'brief.pdf',
  mime: 'application/pdf',
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
const briefFile = (uploadId: string): AttachedFile => ({
  kind: 'local',
  uploadId,
  file: new File(['hello'], 'brief.pdf', { type: 'application/pdf' }),
  localUrl: 'blob:brief',
  isImage: false,
});

beforeEach(() => {
  newSession.mockClear();
  startSessionWithPrompt.mockClear();
  renderToStaticMarkup(createElement(ProjectIndexPage));
});

test('project-home send with an unfinished upload navigates and paints before the upload finishes, then posts the prompt', async () => {
  let finishUpload: (() => void) | undefined;
  configureKortix({
    backendUrl: 'https://api.test',
    getToken: async () => 'token',
    fetch: async (url, init) => {
      if (init?.method === 'PUT') return Response.json({ received_bytes: 5, size: 5 });
      if (String(url).endsWith('/complete'))
        return new Promise<Response>((resolve) => {
          finishUpload = () => resolve(Response.json(metadata));
        });
      return Response.json({ ...metadata, upload: { kind: 'chunked', chunk_size: 65536 } });
    },
  });

  // The composer's own controller, as `usePromptAttachments` creates it.
  const controller = createPromptAttachmentController('project-1');
  const [uploadId] = controller.addMany([new File(['hello'], 'brief.pdf', { type: 'application/pdf' })]);
  const files = [briefFile(uploadId!)];
  const attachments = captureAttachmentSubmission(
    files,
    { ...controller, attachments: controller.getSnapshot().attachments },
    (work) => work,
  )!;
  expect(attachments.readyAtSend).toBe(false);

  const sent = Promise.resolve(home.onSend('read this', files, {}, attachments));
  await settle();
  // Send did not wait for the upload: the session is created now, without the
  // prompt, whose upload handle does not exist yet.
  expect(finishUpload).toBeDefined();
  expect(newSession).toHaveBeenCalledTimes(1);
  const options = newSession.mock.calls[0]![0];
  expect(options.create?.pending_prompt).toBeUndefined();
  options.onNavigate?.('session-1');
  await sent;

  // The session page draws the message from its first frame while the upload runs.
  expect(useFirstPromptPreviewStore.getState().previewBySession['session-1']).toEqual({
    text: 'read this',
    files,
  });
  expect(startSessionWithPrompt).not.toHaveBeenCalled();

  // Navigation unmounts the composer while the upload still runs.
  controller.dispose();
  finishUpload!();
  await settle();
  expect(startSessionWithPrompt).toHaveBeenCalledTimes(1);
  // The Send-time stamp is asserted in the next test.
  const { clientSentAtMs } = startSessionWithPrompt.mock.calls[0]![2] as { clientSentAtMs?: unknown };
  expect(typeof clientSentAtMs).toBe('number');
  expect(startSessionWithPrompt.mock.calls[0]).toEqual([
    'project-1',
    'session-1',
    {
      parts: [{ type: 'text', text: 'read this' }, filePart],
      overrides: {},
      clientSentAtMs,
    },
  ]);
});

test('a held send refused for a connector posts its prompt after the gate Retry opens the session', async () => {
  let finishUpload: (() => void) | undefined;
  configureKortix({
    backendUrl: 'https://api.test',
    getToken: async () => 'token',
    fetch: async (url, init) => {
      if (init?.method === 'PUT') return Response.json({ received_bytes: 5, size: 5 });
      if (String(url).endsWith('/complete'))
        return new Promise<Response>((resolve) => {
          finishUpload = () => resolve(Response.json(metadata));
        });
      return Response.json({ ...metadata, upload: { kind: 'chunked', chunk_size: 65536 } });
    },
  });
  const controller = createPromptAttachmentController('project-1');
  const [uploadId] = controller.addMany([new File(['hello'], 'brief.pdf', { type: 'application/pdf' })]);
  const files = [briefFile(uploadId!)];
  const attachments = captureAttachmentSubmission(
    files,
    { ...controller, attachments: controller.getSnapshot().attachments },
    (work) => work,
  )!;
  expect(attachments.readyAtSend).toBe(false);

  const sent = Promise.resolve(home.onSend('read this', files, {}, attachments));
  await settle();
  const options = newSession.mock.calls[0]![0];
  // The create is refused with a connector requirement: the hook opens the gate and reports it.
  options.onError?.();
  await expect(sent).rejects.toThrow('Session creation failed');
  // `runComposerSend` returns the uploads to the tray.
  controller.reclaim(attachments.submittedIds);

  // The gate's Retry creates the session with the same options, and navigation unmounts the composer.
  options.onNavigate?.('session-gate');
  controller.dispose();
  finishUpload!();
  await settle();

  expect(startSessionWithPrompt).toHaveBeenCalledTimes(1);
  const { clientSentAtMs } = startSessionWithPrompt.mock.calls[0]![2] as { clientSentAtMs?: unknown };
  expect(startSessionWithPrompt.mock.calls[0]).toEqual([
    'project-1',
    'session-gate',
    { parts: [{ type: 'text', text: 'read this' }, filePart], overrides: {}, clientSentAtMs },
  ]);
});

test('a ready send refused for a connector posts nothing more after the gate Retry: the create carries the prompt', async () => {
  const events: string[] = [];
  const attachments: AttachmentSubmission = {
    submittedIds: ['attachment-1'],
    readyAtSend: true,
    whenReady: async () => [filePart],
    retry: () => {},
    resubmit: () => {
      events.push('resubmit');
    },
    release: () => {
      events.push('release');
    },
  };
  const files = [briefFile('attachment-1')];

  const sent = Promise.resolve(home.onSend('read this', files, {}, attachments));
  await settle();
  const options = newSession.mock.calls[0]![0];
  expect(options.create?.pending_prompt?.parts).toEqual([{ type: 'text', text: 'read this' }, filePart]);
  options.onError?.();
  await expect(sent).rejects.toThrow('Session creation failed');
  options.onNavigate?.('session-gate-ready');
  await settle();

  expect(startSessionWithPrompt).not.toHaveBeenCalled();
  expect(events).toEqual([]);
});

test('the held first prompt carries its Send time, earlier than a message sent after navigation', async () => {
  let finishUpload!: () => void;
  const uploaded = new Promise<void>((resolve) => {
    finishUpload = resolve;
  });
  const attachments: AttachmentSubmission = {
    submittedIds: ['attachment-1'],
    readyAtSend: false,
    whenReady: async () => {
      await uploaded;
      return [filePart];
    },
    retry: () => {},
    resubmit: () => {},
    release: () => {},
  };
  const files = [briefFile('attachment-1')];

  const sendAtMs = Date.now();
  const sent = Promise.resolve(home.onSend('read this', files, {}, attachments));
  await settle();
  newSession.mock.calls[0]![0].onNavigate?.('session-4');
  await sent;
  await settle();
  // A follow-up sent on the session page while the upload runs is stamped now.
  // The server orders rows by this stamp, so the first prompt must be earlier.
  const followUpSentAtMs = Date.now();
  finishUpload();
  await settle();

  expect(startSessionWithPrompt).toHaveBeenCalledTimes(1);
  const input = startSessionWithPrompt.mock.calls[0]![2] as { clientSentAtMs?: number };
  expect(input.clientSentAtMs).toBeGreaterThanOrEqual(sendAtMs);
  expect(input.clientSentAtMs).toBeLessThan(followUpSentAtMs);
});

test('an upload that fails after navigation keeps the first prompt on screen, marked failed; Retry restarts the upload and posts', async () => {
  let waits = 0;
  const events: string[] = [];
  const attachments: AttachmentSubmission = {
    submittedIds: ['attachment-1'],
    readyAtSend: false,
    whenReady: async () => {
      waits += 1;
      if (waits === 1) throw new Error('brief.pdf did not upload');
      return [filePart];
    },
    retry: () => {
      events.push('retry');
    },
    resubmit: () => {},
    release: () => {
      events.push('release');
    },
  };
  const files = [briefFile('attachment-1')];

  const sent = Promise.resolve(home.onSend('read this', files, {}, attachments));
  await settle();
  newSession.mock.calls[0]![0].onNavigate?.('session-2');
  await sent;
  await settle();

  const failed = useFirstPromptPreviewStore.getState().previewBySession['session-2'];
  expect(failed?.text).toBe('read this');
  // The page words the reason in the active locale (the translator mock returns the key). A
  // connection failure asks for a retry; it never says "Upload failed".
  expect(failed?.uploadStatus).toMatchObject({ state: 'failed', message: 'checkConnection' });
  expect(startSessionWithPrompt).not.toHaveBeenCalled();

  failed!.uploadStatus!.onRetry!();
  await settle();
  expect(useFirstPromptPreviewStore.getState().previewBySession['session-2']?.uploadStatus).toBeUndefined();
  expect(startSessionWithPrompt).toHaveBeenCalledTimes(1);
  expect(events).toEqual(['retry', 'release']);
});

test('uploads already finished at Send keep the create carrying the prompt', async () => {
  const events: string[] = [];
  const attachments: AttachmentSubmission = {
    submittedIds: ['attachment-1'],
    readyAtSend: true,
    whenReady: async () => [filePart],
    retry: () => {},
    resubmit: () => {},
    release: () => {
      events.push('release');
    },
  };
  const files = [briefFile('attachment-1')];

  const sent = Promise.resolve(home.onSend('read this', files, {}, attachments));
  await settle();
  const options = newSession.mock.calls[0]![0];
  expect(options.create?.pending_prompt?.parts).toEqual([{ type: 'text', text: 'read this' }, filePart]);
  options.onNavigate?.('session-3');
  await sent;
  expect(events).toEqual(['release']);
  expect(startSessionWithPrompt).not.toHaveBeenCalled();
});

test('project-home held first prompt and a session-page send for the same session POST in Enter order', async () => {
  let finishUpload!: () => void;
  const uploaded = new Promise<void>((resolve) => {
    finishUpload = resolve;
  });
  const attachments: AttachmentSubmission = {
    submittedIds: ['attachment-1'],
    readyAtSend: false,
    whenReady: async () => {
      await uploaded;
      return [filePart];
    },
    retry: () => {},
    resubmit: () => {},
    release: () => {},
  };
  const sent = Promise.resolve(home.onSend('read this', [briefFile('attachment-1')], {}, attachments));
  await settle();
  newSession.mock.calls[0]![0].onNavigate?.('session-5');
  await sent;

  // The session page's composer sends a text-only follow-up while the first
  // prompt still uploads, through the helper SessionChat calls.
  let firstPromptPostsAtFollowUp: number | undefined;
  const followUp = deliverAfterPaint(
    'session-5',
    {
      submittedIds: [],
      readyAtSend: true,
      whenReady: async () => [],
      retry: () => {},
      resubmit: () => {},
      release: () => {},
    },
    async () => {
      firstPromptPostsAtFollowUp = startSessionWithPrompt.mock.calls.length;
      return 'posted';
    },
    'painted',
  );
  expect(firstPromptPostsAtFollowUp).toBeUndefined();
  // The follow-up does not hold the composer while it waits.
  expect(await followUp).toBe('painted');

  finishUpload();
  await settle();
  expect(startSessionWithPrompt).toHaveBeenCalledTimes(1);
  // The follow-up POSTed only after the first prompt's POST.
  expect(firstPromptPostsAtFollowUp).toBe(1);
});
