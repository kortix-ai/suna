import { describe, expect, mock, setSystemTime, spyOn, test } from 'bun:test';

import {
  ApiError,
  BillingError,
  type PromptAttachmentItem,
  type PromptAttachmentStatus,
  type SessionPromptPart,
} from '@kortix/sdk';
import type { AttachmentUploadStatus } from '@/features/session/turn/user-message';
import {
  attachmentFailureReason,
  attachmentFailureRetryable,
  attachmentsBlockSend,
  captureAttachmentSubmission,
  deliverAfterPaint,
  planAttachmentReplacement,
  postWhenUploaded,
  runComposerSend,
  SENT_FAILURE_COPY,
  stageComposerFiles,
  takeNewBillingRefusals,
  type AttachmentSubmission,
  type AttachmentSubmissionController,
} from './attachment-submission';
import type { AttachedFile } from './types';

const selectedFile = (
  uploadId: string,
  filename: string,
): Extract<AttachedFile, { kind: 'local' }> => ({
  kind: 'local',
  uploadId,
  file: new File(['ready'], filename, { type: 'text/plain' }),
  localUrl: `blob:${uploadId}`,
  isImage: false,
});

const item = (id: string, status: PromptAttachmentStatus): PromptAttachmentItem => ({
  id,
  filename: `${id}.txt`,
  mime: 'text/plain',
  size: 5,
  status,
  receivedBytes: status === 'ready' ? 5 : 2,
});

function fakeController(items: PromptAttachmentItem[]) {
  const calls: string[] = [];
  const controller: AttachmentSubmissionController = {
    attachments: items,
    submit: (ids) => {
      calls.push(`submit:${ids.join(',')}`);
    },
    retry: (id) => {
      calls.push(`retry:${id}`);
    },
    forget: (ids) => {
      calls.push(`forget:${ids.join(',')}`);
    },
    reclaim: (ids) => {
      calls.push(`reclaim:${ids.join(',')}`);
    },
    whenReady: async (ids): Promise<SessionPromptPart[]> => {
      calls.push(`whenReady:${ids.join(',')}`);
      return ids.map((id) => ({
        type: 'file',
        attachment_id: `att-${id}`,
        filename: `${id}.txt`,
        mime: 'text/plain',
      }));
    },
  };
  return { controller, calls };
}

describe('captureAttachmentSubmission', () => {
  test('hands off uploading attachments at capture, in selected order, without waiting', async () => {
    const { controller, calls } = fakeController([
      item('local-a', 'ready'),
      item('local-b', 'uploading'),
    ]);
    const held: Promise<unknown>[] = [];
    const submission = captureAttachmentSubmission(
      [selectedFile('local-b', 'b.txt'), selectedFile('local-a', 'a.txt')],
      controller,
      (work) => {
        held.push(work);
        return work;
      },
    );

    expect(submission?.submittedIds).toEqual(['local-b', 'local-a']);
    expect(calls).toEqual(['submit:local-b,local-a']);
    const parts = await submission!.whenReady();
    expect(calls).toEqual(['submit:local-b,local-a', 'whenReady:local-b,local-a']);
    expect(parts.map((part) => part.attachment_id)).toEqual(['att-local-b', 'att-local-a']);
    // The wait is what the tab's unload warning holds on.
    expect(held).toHaveLength(1);
  });

  test('refuses a selection with a failed attachment and hands nothing off', () => {
    const { controller, calls } = fakeController([item('ok', 'uploading'), item('bad', 'error')]);
    expect(
      captureAttachmentSubmission(
        [selectedFile('ok', 'ok.txt'), selectedFile('bad', 'bad.txt')],
        controller,
        (work) => work,
      ),
    ).toBeNull();
    expect(calls).toEqual([]);
  });

  test('a send without uploads touches no controller and resolves no parts', async () => {
    const { controller, calls } = fakeController([]);
    const submission = captureAttachmentSubmission([], controller, (work) => work);
    expect(submission?.submittedIds).toEqual([]);
    expect(submission?.readyAtSend).toBe(true);
    expect(await submission!.whenReady()).toEqual([]);
    submission!.retry();
    submission!.release();
    expect(calls).toEqual([]);
  });

  test('records whether every selected upload was ready at Send', () => {
    const ready = fakeController([item('a', 'ready')]).controller;
    const running = fakeController([item('a', 'ready'), item('b', 'uploading')]).controller;
    expect(
      captureAttachmentSubmission([selectedFile('a', 'a.txt')], ready, (work) => work)?.readyAtSend,
    ).toBe(true);
    expect(
      captureAttachmentSubmission(
        [selectedFile('a', 'a.txt'), selectedFile('b', 'b.txt')],
        running,
        (work) => work,
      )?.readyAtSend,
    ).toBe(false);
  });

  test('retry restarts only this send’s uploads, and release forgets them', () => {
    const { controller, calls } = fakeController([
      item('a', 'uploading'),
      item('b', 'uploading'),
      item('other', 'uploading'),
    ]);
    const submission = captureAttachmentSubmission(
      [selectedFile('a', 'a.txt'), selectedFile('b', 'b.txt')],
      controller,
      (work) => work,
    )!;
    submission.retry();
    submission.release();
    expect(calls).toEqual(['submit:a,b', 'retry:a', 'retry:b', 'forget:a,b']);
  });
});

describe('postWhenUploaded', () => {
  const part: SessionPromptPart = {
    type: 'file',
    attachment_id: 'att-a',
    filename: 'a.txt',
    mime: 'text/plain',
  };
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  /** A painted send whose wait answers from `results`, one per call. */
  function paintedSend(results: Array<Error | SessionPromptPart[]>) {
    const events: string[] = [];
    const submission: AttachmentSubmission = {
      submittedIds: ['a'],
      readyAtSend: false,
      whenReady: async () => {
        const next = results.shift()!;
        if (next instanceof Error) throw next;
        return next;
      },
      retry: () => {
        events.push('retry');
      },
      release: () => {
        events.push('release');
      },
    };
    return { submission, events };
  }

  /** The host's localized reason for a failure. */
  const describe = (error: unknown) => `reason: ${(error as Error).message}`;

  test('posts once the uploads are ready, then releases them', async () => {
    const { submission, events } = paintedSend([[part]]);
    const statuses: Array<AttachmentUploadStatus | undefined> = [];
    await postWhenUploaded(
      'post-ready',
      submission,
      async (parts) => {
        events.push(`post:${parts.map((p) => p.attachment_id).join(',')}`);
      },
      (status) => statuses.push(status),
      describe,
    );
    expect(events).toEqual(['post:att-a', 'release']);
    expect(statuses).toEqual([]);
  });

  test('an upload failure keeps the send, marked failed with the host reason; Retry restarts the uploads, then posts', async () => {
    const { submission, events } = paintedSend([new Error('a.txt did not upload'), [part]]);
    let status: AttachmentUploadStatus | undefined;
    const post = mock(async (_parts: SessionPromptPart[]) => {
      events.push('post');
    });
    await postWhenUploaded('post-upload-failure', submission, post, (next) => (status = next), describe);

    expect(post).not.toHaveBeenCalled();
    expect(events).toEqual([]);
    expect(status).toMatchObject({ state: 'failed', message: 'reason: a.txt did not upload' });

    status!.onRetry!();
    expect(status).toBeUndefined();
    await tick();
    expect(events).toEqual(['retry', 'post', 'release']);
  });

  test('a failed POST keeps the send too; Retry posts again and uploads nothing new', async () => {
    const { submission, events } = paintedSend([[part], [part]]);
    let status: AttachmentUploadStatus | undefined;
    let attempts = 0;
    await postWhenUploaded(
      'post-failure',
      submission,
      async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('Network down');
        events.push('post');
      },
      (next) => (status = next),
      describe,
    );
    expect(status).toMatchObject({ state: 'failed', message: 'reason: Network down' });
    expect(events).toEqual([]);

    status!.onRetry!();
    await tick();
    expect(status).toBeUndefined();
    expect(events).toEqual(['retry', 'post', 'release']);
  });
});

describe('deliverAfterPaint', () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const carrying = (ids: string[]): AttachmentSubmission => ({
    submittedIds: ids,
    readyAtSend: ids.length === 0,
    whenReady: async () => [],
    retry: () => {},
    release: () => {},
  });
  /** An upload that finishes, or fails, only when the test says so. */
  const heldUpload = () => {
    let finish!: () => void;
    let fail!: (error: Error) => void;
    const done = new Promise<void>((resolve, reject) => {
      finish = resolve;
      fail = reject;
    });
    return { done, finish, fail };
  };

  test('a painted send with uploads returns at once; its delivery keeps running', async () => {
    const upload = heldUpload();
    const events: string[] = [];
    const result = await deliverAfterPaint(
      'paint-uploads',
      carrying(['a']),
      async (detached) => {
        await upload.done;
        events.push(`posted detached=${detached}`);
        return 'posted';
      },
      'painted',
    );

    expect(result).toBe('painted');
    expect(events).toEqual([]);
    upload.finish();
    await tick();
    expect(events).toEqual(['posted detached=true']);
  });

  test('a send without uploads, with nothing of its session ahead, waits for its POST, so a refusal reaches the composer', async () => {
    await expect(
      deliverAfterPaint(
        'paint-inline',
        carrying([]),
        async (detached) => {
          throw new Error(`refused detached=${detached}`);
        },
        'painted',
      ),
    ).rejects.toThrow('refused detached=false');
    await expect(
      deliverAfterPaint('paint-inline', undefined, async () => 'posted', 'painted'),
    ).resolves.toBe('posted');
  });

  test('a failed held delivery settles and the next send still POSTs', async () => {
    const consoleError = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const events: string[] = [];
      // A held send whose delivery rejects when its upload fails.
      const upload = heldUpload();
      await deliverAfterPaint(
        'failed-held',
        carrying(['a']),
        async () => {
          await upload.done;
          events.push('first posted');
          return 'posted';
        },
        'painted',
      );
      const second = deliverAfterPaint(
        'failed-held',
        carrying([]),
        async () => {
          events.push('second posted');
          return 'posted';
        },
        'painted',
      );
      expect(await second).toBe('painted');
      upload.fail(new Error('a.txt did not upload'));
      await tick();
      expect(events).toEqual(['second posted']);

      // A held send that `postWhenUploaded` marks failed settles its link too.
      const failing = heldUpload();
      let status: AttachmentUploadStatus | undefined;
      void postWhenUploaded(
        'failed-held',
        {
          ...carrying(['b']),
          whenReady: async () => {
            await failing.done;
            return [];
          },
        },
        async () => {
          events.push('third posted');
        },
        (next) => (status = next),
        (error) => (error as Error).message,
      );
      const fourth = deliverAfterPaint(
        'failed-held',
        carrying([]),
        async () => {
          events.push('fourth posted');
          return 'posted';
        },
        'painted',
      );
      expect(await fourth).toBe('painted');
      failing.fail(new Error('b.txt did not upload'));
      await tick();
      expect(status).toMatchObject({ state: 'failed', message: 'b.txt did not upload' });
      expect(events).toEqual(['second posted', 'fourth posted']);
    } finally {
      consoleError.mockRestore();
    }
  });

  test('a Retry of a failed held send enqueues at the chain tail', async () => {
    const events: string[] = [];
    let status: AttachmentUploadStatus | undefined;
    let waits = 0;
    await postWhenUploaded(
      'retry-tail',
      {
        ...carrying(['a']),
        whenReady: async () => {
          waits += 1;
          if (waits === 1) throw new Error('a.txt did not upload');
          return [];
        },
        retry: () => {
          events.push('retry a');
        },
      },
      async () => {
        events.push('first posted');
      },
      (next) => (status = next),
      (error) => (error as Error).message,
    );
    expect(status).toMatchObject({ state: 'failed' });

    // A later send, still uploading, now holds the head of the chain.
    const later = heldUpload();
    void postWhenUploaded(
      'retry-tail',
      {
        ...carrying(['b']),
        whenReady: async () => {
          await later.done;
          return [];
        },
      },
      async () => {
        events.push('later posted');
      },
      () => {},
      String,
    );

    // Retry restarts the upload at once; its POST waits behind the later send.
    status!.onRetry!();
    await tick();
    expect(events).toEqual(['retry a']);
    later.finish();
    await tick();
    expect(events).toEqual(['retry a', 'later posted', 'first posted']);
  });

  test("session B is not blocked by session A's pending chain", async () => {
    const events: string[] = [];
    const upload = heldUpload();
    await deliverAfterPaint(
      'session-a',
      carrying(['a']),
      async () => {
        await upload.done;
        events.push('a posted');
        return 'posted';
      },
      'painted',
    );
    // Nothing of session B is ahead of this send: it waits for its own POST only.
    expect(
      await deliverAfterPaint(
        'session-b',
        carrying([]),
        async () => {
          events.push('b posted');
          return 'posted';
        },
        'painted',
      ),
    ).toBe('posted');
    expect(events).toEqual(['b posted']);

    upload.finish();
    await tick();
    expect(events).toEqual(['b posted', 'a posted']);
  });

  test('a caller without a submission (not the composer) waits in order behind its session', async () => {
    const events: string[] = [];
    const upload = heldUpload();
    await deliverAfterPaint(
      'no-submission',
      carrying(['a']),
      async () => {
        await upload.done;
        events.push('held posted');
        return 'posted';
      },
      'painted',
    );
    let settled = false;
    const sender = deliverAfterPaint(
      'no-submission',
      undefined,
      async (detached) => {
        events.push(`sender posted detached=${detached}`);
        return 'posted';
      },
      'painted',
    ).then((result) => {
      settled = true;
      return result;
    });
    await tick();
    expect(settled).toBe(false);
    expect(events).toEqual([]);

    upload.finish();
    expect(await sender).toBe('posted');
    expect(events).toEqual(['held posted', 'sender posted detached=false']);
  });

  test('an inline edit sent while an earlier held Send waits POSTs immediately and is not delayed behind the chain', async () => {
    const events: string[] = [];
    const upload = heldUpload();
    await deliverAfterPaint(
      'inline-edit',
      carrying(['a']),
      async () => {
        await upload.done;
        events.push('held posted');
        return 'posted';
      },
      'painted',
    );

    // The edit's send commits its staged rewind, so it POSTs in this tick.
    const edit = deliverAfterPaint(
      'inline-edit',
      undefined,
      async (detached) => {
        events.push(`edit posted detached=${detached}`);
        return 'posted';
      },
      'painted',
      { immediate: true },
    );
    expect(events).toEqual(['edit posted detached=false']);
    // It waits for its own POST only, so a refusal still reaches the edit.
    expect(await edit).toBe('posted');
    await expect(
      deliverAfterPaint(
        'inline-edit',
        undefined,
        async () => {
          throw new Error('refused');
        },
        'painted',
        { immediate: true },
      ),
    ).rejects.toThrow('refused');

    // It took no place in the chain: a later send still waits behind the held send only.
    expect(
      await deliverAfterPaint(
        'inline-edit',
        carrying([]),
        async () => {
          events.push('later posted');
          return 'posted';
        },
        'painted',
      ),
    ).toBe('painted');
    expect(events).toEqual(['edit posted detached=false']);
    upload.finish();
    await tick();
    expect(events).toEqual(['edit posted detached=false', 'held posted', 'later posted']);
  });
});

describe('runComposerSend', () => {
  const submission = (ids: string[]): AttachmentSubmission => ({
    submittedIds: ids,
    readyAtSend: false,
    whenReady: async () => [],
    retry: () => {},
    release: () => {},
  });

  test('the ids stay protected while the host takes the send; success reclaims nothing', async () => {
    const { controller, calls } = fakeController([]);
    const active = new Set<string>();
    const seen: string[][] = [];
    const events: string[] = [];
    await runComposerSend({
      submission: submission(['a', 'b']),
      controller,
      active,
      send: async () => {
        seen.push([...active]);
      },
      onSent: () => events.push('sent'),
      onFailed: () => events.push('failed'),
    });

    expect(seen).toEqual([['a', 'b']]);
    expect([...active]).toEqual([]);
    expect(events).toEqual(['sent']);
    expect(calls).toEqual([]);
  });

  test('a host that throws gets the uploads back in the tray and the draft restored', async () => {
    const { controller, calls } = fakeController([]);
    const active = new Set<string>();
    const events: string[] = [];
    await runComposerSend({
      submission: submission(['a']),
      controller,
      active,
      send: async () => {
        throw new Error('Session creation failed');
      },
      onSent: () => events.push('sent'),
      onFailed: () => events.push('restored'),
    });

    expect(calls).toEqual(['reclaim:a']);
    expect(events).toEqual(['restored']);
    expect([...active]).toEqual([]);
  });
});

describe('attachmentFailureReason', () => {
  test('names the refusals Retry cannot fix; any other failure is a connection failure', () => {
    expect(attachmentFailureReason(new BillingError(402, { message: 'Out of credits' }))).toBe(
      'billing',
    );
    expect(
      attachmentFailureReason(
        new ApiError('Unsent attachments are limited', {
          status: 429,
          code: 'attachment_budget_exceeded',
        }),
      ),
    ).toBe('budget');
    // A plain 429 is a rate limit the SDK already retried: Retry can succeed.
    expect(attachmentFailureReason(new ApiError('Slow down', { status: 429, code: '429' }))).toBe(
      'connection',
    );
    expect(
      attachmentFailureReason(
        new ApiError('Each attachment must contain 1 byte to 50 MiB.', {
          status: 413,
          code: 'attachment_size_limit',
        }),
      ),
    ).toBe('tooLarge');
    expect(
      attachmentFailureReason(
        new ApiError('Attachment expired. Attach the file again.', { code: 'attachment_expired' }),
      ),
    ).toBe('expired');
    expect(
      attachmentFailureReason(new ApiError('Network error', { name: 'TypeError' })),
    ).toBe('connection');
    expect(attachmentFailureReason(new Error('socket hang up'))).toBe('connection');
    expect(attachmentFailureReason(undefined)).toBe('connection');
  });

  test('only a connection failure offers Retry on the composer tile', () => {
    expect(attachmentFailureRetryable('connection')).toBe(true);
    for (const reason of ['billing', 'budget', 'tooLarge', 'expired'] as const)
      expect(attachmentFailureRetryable(reason)).toBe(false);
  });
});

describe('takeNewBillingRefusals', () => {
  test('returns each billing refusal once and never a connection failure', () => {
    const seen = new WeakSet<object>();
    const outOfCredits = new BillingError(402, { message: 'Out of credits' });
    const items: PromptAttachmentItem[] = [
      { ...item('a', 'error'), error: outOfCredits },
      { ...item('b', 'error'), error: new Error('socket hang up') },
      item('c', 'uploading'),
    ];

    expect(takeNewBillingRefusals(items, seen)).toEqual([outOfCredits]);
    // The next snapshot still lists the same failed tile: no second dialog.
    expect(takeNewBillingRefusals(items, seen)).toEqual([]);
  });
});

describe('SENT_FAILURE_COPY', () => {
  test('a sent message names the reason and never says "Upload failed"', () => {
    expect(SENT_FAILURE_COPY).toEqual({
      billing: 'billingRequired',
      budget: 'budgetExceeded',
      tooLarge: 'tooLarge',
      expired: 'expired',
      connection: 'checkConnection',
    });
    expect(Object.values(SENT_FAILURE_COPY)).not.toContain('uploadFailed');
  });
});

describe('attachmentsBlockSend', () => {
  test('only a failed attachment refuses Send; pending and uploading never do', () => {
    for (const status of ['pending', 'uploading', 'processing', 'ready'] as const) {
      expect(attachmentsBlockSend([item('a', status)])).toBe(false);
    }
    expect(attachmentsBlockSend([item('a', 'uploading'), item('b', 'error')])).toBe(true);
    expect(attachmentsBlockSend([item('a', 'aborted')])).toBe(true);
    expect(attachmentsBlockSend([])).toBe(false);
  });
});

describe('stageComposerFiles', () => {
  test('validates the whole batch before creating any object URL', () => {
    const events: string[] = [];
    const files = [
      new File(['a'], 'a.txt', { type: 'text/plain' }),
      new File(['b'], 'b.txt', { type: 'text/plain' }),
    ];

    const attached = stageComposerFiles(files, {
      addMany: (selected) => {
        events.push(`add:${selected.map((file) => file.name).join(',')}`);
        return ['upload-a', 'upload-b'];
      },
      createObjectURL: (file) => {
        events.push(`url:${file.name}`);
        return `blob:${file.name}`;
      },
      isImage: () => false,
    });

    expect(events).toEqual(['add:a.txt,b.txt', 'url:a.txt', 'url:b.txt']);
    expect(attached.map((file) => file.kind === 'local' && file.uploadId)).toEqual([
      'upload-a',
      'upload-b',
    ]);
  });

  test('stamps the attach time on every staged file, for the tile ring delay', () => {
    setSystemTime(new Date(5_000));
    try {
      const attached = stageComposerFiles(
        [new File(['a'], 'a.txt'), new File(['b'], 'b.txt')],
        {
          addMany: () => ['upload-a', 'upload-b'],
          createObjectURL: (file) => `blob:${file.name}`,
          isImage: () => false,
        },
      );
      expect(attached.map((file) => file.attachedAt)).toEqual([5_000, 5_000]);
    } finally {
      setSystemTime();
    }
  });

  test('creates no object URLs when synchronous batch validation fails', () => {
    let objectUrls = 0;
    expect(() =>
      stageComposerFiles([new File(['x'], 'too-many.txt')], {
        addMany: () => {
          throw new Error('A message can contain up to 20 attachments');
        },
        createObjectURL: () => {
          objectUrls += 1;
          return 'blob:leaked';
        },
        isImage: () => false,
      }),
    ).toThrow('up to 20 attachments');
    expect(objectUrls).toBe(0);
  });
});

describe('planAttachmentReplacement', () => {
  test('removes superseded SDK entries and URLs but preserves active submissions', () => {
    const removed = selectedFile('removed', 'removed.txt');
    const active = selectedFile('active', 'active.txt');
    const kept = selectedFile('kept', 'kept.txt');
    expect(planAttachmentReplacement([removed, active, kept], [kept], new Set(['active']))).toEqual(
      {
        idsToRemove: ['removed'],
        urlsToRevoke: ['blob:removed'],
      },
    );
  });
});
