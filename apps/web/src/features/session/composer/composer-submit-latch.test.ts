/**
 * One user action = one submission — and the NEXT user action must survive.
 *
 * The latch's BEHAVIOR (defer a typed second message, drop a same-tick
 * double-fire, release on throw) is asserted with real promises in
 * `submit-latch.test.ts`. The send behavior below runs the exported helpers
 * `composer.tsx` and its hosts call — `captureAttachmentSubmission`,
 * `runComposerSend`, `deliverAfterPaint`, `dispatchLatched`, `createSubmitLatch`
 * — so a regression in any of them fails here. Source assertions pin only the
 * wiring: which helper each call site uses.
 *
 * Source assertions, for the reason stated in `session-chat-queued-retry-id.test.ts`:
 * `apps/web` has no DOM harness, and the composer sits behind a `React.lazy`
 * boundary. Every slice goes through `between()`, which FAILS on a missing
 * anchor rather than yielding '' and passing.
 *
 * History: the first latch was an inline `if (submissionInFlight.current)
 * return;`. That blanket return held the gate for the entire await of the
 * previous send's ACK (seconds with uploads, ~30s against a waking sandbox)
 * and silently dropped every submission inside the window — the "second
 * message never queues, Enter does nothing" bug. The expectation this file
 * used to pin was that behavior; it changed on purpose.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { PromptAttachmentStatus, SessionPromptPart } from '@kortix/sdk';

import {
  captureAttachmentSubmission,
  deliverAfterPaint,
  dispatchLatched,
  runComposerSend,
  type AttachmentSubmission,
  type AttachmentSubmissionController,
  type DispatchOutcome,
} from './attachment-submission';
import { createSubmitLatch } from './submit-latch';
import type { AttachedFile } from './types';

const source = readFileSync(fileURLToPath(new URL('./composer.tsx', import.meta.url)), 'utf8');

/** The file with comments removed, for assertions about what CODE references. */
function code(): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
}

function between(start: string, end: string): string {
  const from = source.indexOf(start);
  expect(from, `anchor not found: ${start}`).toBeGreaterThan(-1);
  const to = source.indexOf(end, from + start.length);
  expect(to, `anchor not found after ${start}: ${end}`).toBeGreaterThan(from);
  return source.slice(from, to);
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
let sessionCount = 0;

const fileA: AttachedFile = {
  kind: 'local',
  uploadId: 'local-a',
  file: new File(['hello'], 'a.txt', { type: 'text/plain' }),
  localUrl: 'blob:a',
  isImage: false,
};

/** A controller whose one upload finishes only when the test releases it. */
function heldUpload(status: PromptAttachmentStatus = 'uploading') {
  let release!: () => void;
  const uploaded = new Promise<void>((resolve) => (release = resolve));
  const handedOff: string[][] = [];
  const reclaimed: string[][] = [];
  const controller: AttachmentSubmissionController = {
    attachments: [
      { id: 'local-a', filename: 'a.txt', mime: 'text/plain', size: 5, status, receivedBytes: 2 },
    ],
    submit: (ids) => {
      handedOff.push([...ids]);
    },
    retry: () => {},
    forget: () => {},
    reclaim: (ids) => {
      reclaimed.push([...ids]);
    },
    whenReady: async (ids): Promise<SessionPromptPart[]> => {
      await uploaded;
      return ids.map((id) => ({
        type: 'file',
        attachment_id: `att-${id}`,
        filename: 'a.txt',
        mime: 'text/plain',
      }));
    },
  };
  return { controller, handedOff, reclaimed, release };
}

type Draft = { text: string; files: AttachedFile[] };
type Stash = Draft & { attachmentSubmission: AttachmentSubmission };

/**
 * A composer and its host, wired the way `composer.tsx` and `SessionChat` are:
 * capture, `runComposerSend`, the host paints, then `deliverAfterPaint`.
 *
 * `refuse`: the host throws before painting (a create refusal).
 * `slowPost`: a text-only POST waits on it, which keeps the dispatch in flight.
 * `stopStash`: a stashed draft stops before the host (`submitDisabled`, or an open question).
 */
function composerAndHost(
  controller: AttachmentSubmissionController,
  options: { refuse?: boolean; slowPost?: Promise<void>; stopStash?: 'refused' | 'answered' } = {},
) {
  const editor: Draft = { text: '', files: [] };
  const painted: string[] = [];
  const posted: string[] = [];
  const active = new Set<string>();

  // One session per composer: an upload one test never releases cannot hold
  // another test's sends in its delivery chain.
  const sessionKey = `latch-session-${++sessionCount}`;
  const onSend = async (text: string, submission: AttachmentSubmission) => {
    if (options.refuse) throw new Error('Session creation failed');
    painted.push(text);
    return deliverAfterPaint(
      sessionKey,
      submission,
      async () => {
        const parts = await submission.whenReady();
        if (parts.length === 0) await options.slowPost;
        posted.push(text);
      },
      undefined,
    );
  };

  const dispatch = async (stash?: Stash): Promise<DispatchOutcome> => {
    if (stash && options.stopStash === 'refused') return;
    if (stash && options.stopStash === 'answered') return 'answered';
    const draft: Draft = stash ?? { text: editor.text, files: editor.files };
    const submission =
      stash?.attachmentSubmission ??
      captureAttachmentSubmission(draft.files, controller, (work) => work);
    if (!submission) return;
    if (!stash) {
      editor.text = '';
      editor.files = [];
    }
    await runComposerSend({
      submission,
      controller,
      active,
      send: () => onSend(draft.text, submission),
      onSent: () => {},
      onFailed: () => {
        editor.text = draft.text;
        editor.files = [...editor.files, ...draft.files];
      },
    });
    return 'sent';
  };

  const submit = createSubmitLatch<Stash>(
    (stash) =>
      dispatchLatched(stash, dispatch, controller, (returned, withText) => {
        if (withText) editor.text = returned.text;
        editor.files = [...editor.files, ...returned.files];
      }),
    () => {
      if (!editor.text.trim()) return null;
      const attachmentSubmission = captureAttachmentSubmission(
        editor.files,
        controller,
        (work) => work,
      );
      if (!attachmentSubmission) return null;
      const stash = { text: editor.text, files: editor.files, attachmentSubmission };
      editor.text = '';
      editor.files = [];
      return stash;
    },
  );

  const type = (text: string, files: AttachedFile[] = []) => {
    editor.text = text;
    editor.files = files;
  };
  return { submit, type, editor, painted, posted, active };
}

describe('Send hands uploads off and never waits for them', () => {
  test('text-only send during a held upload POSTs after the held send', async () => {
    const upload = heldUpload();
    const composer = composerAndHost(upload.controller);

    composer.type('first', [fileA]);
    const first = composer.submit();
    // Same tick: the upload has not finished, and the message is on screen.
    expect(composer.painted).toEqual(['first']);
    expect(upload.handedOff).toEqual([['local-a']]);

    // Enter again while the first dispatch is still in flight: the draft is stashed.
    composer.type('second');
    const second = composer.submit();
    await Promise.all([first, second]);
    await tick();

    // Both messages painted while the first upload still runs. Nothing posted:
    // the text-only send waits behind the held send, so the session gets Enter order.
    expect(composer.painted).toEqual(['first', 'second']);
    expect(composer.posted).toEqual([]);

    upload.release();
    await tick();
    expect(composer.posted).toEqual(['first', 'second']);
  });

  test('text-only send behind a pending chain paints immediately and does not hold the composer latch', async () => {
    const upload = heldUpload();
    const composer = composerAndHost(upload.controller);

    composer.type('first', [fileA]);
    await composer.submit();
    await tick();
    expect(composer.painted).toEqual(['first']);

    // The latch is free; the session's chain still holds the upload.
    composer.type('second');
    const second = composer.submit();
    expect(composer.painted).toEqual(['first', 'second']);
    expect(
      await Promise.race([second.then(() => 'settled'), tick().then(() => 'held')]),
    ).toBe('settled');

    // The next Enter dispatches at once: it paints in the same tick, not after a stash.
    composer.type('third');
    const third = composer.submit();
    expect(composer.painted).toEqual(['first', 'second', 'third']);
    await third;
    expect(composer.posted).toEqual([]);

    upload.release();
    await tick();
    expect(composer.posted).toEqual(['first', 'second', 'third']);
  });

  test('a failed attachment refuses Send: the host is not called and the draft stays', async () => {
    const upload = heldUpload('error');
    const composer = composerAndHost(upload.controller);

    composer.type('look', [fileA]);
    await composer.submit();

    expect(composer.painted).toEqual([]);
    expect(upload.handedOff).toEqual([]);
    expect(composer.editor).toEqual({ text: 'look', files: [fileA] });
  });

  test('a host that refuses before painting returns the uploads and the draft', async () => {
    const upload = heldUpload();
    const composer = composerAndHost(upload.controller, { refuse: true });

    composer.type('look', [fileA]);
    await composer.submit();

    expect(upload.reclaimed).toEqual([['local-a']]);
    expect(composer.editor).toEqual({ text: 'look', files: [fileA] });
    expect(composer.active.size).toBe(0);
  });

  test('a stash refused before the host (submitDisabled) gets its uploads, text, and files back', async () => {
    let releasePost!: () => void;
    const slowPost = new Promise<void>((resolve) => (releasePost = resolve));
    const upload = heldUpload();
    const composer = composerAndHost(upload.controller, { slowPost, stopStash: 'refused' });

    composer.type('first');
    const first = composer.submit();
    composer.type('second draft', [fileA]);
    await composer.submit();
    // Enter took the draft out of the editor and handed its upload off.
    expect(upload.handedOff).toEqual([['local-a']]);
    expect(composer.editor).toEqual({ text: '', files: [] });

    releasePost();
    await first;
    await tick();

    expect(composer.painted).toEqual(['first']);
    expect(upload.reclaimed).toEqual([['local-a']]);
    expect(composer.editor).toEqual({ text: 'second draft', files: [fileA] });
  });

  test('a stash answered to an open question gets its uploads and files back, not its text', async () => {
    let releasePost!: () => void;
    const slowPost = new Promise<void>((resolve) => (releasePost = resolve));
    const upload = heldUpload();
    const composer = composerAndHost(upload.controller, { slowPost, stopStash: 'answered' });

    composer.type('first');
    const first = composer.submit();
    composer.type('second draft', [fileA]);
    await composer.submit();
    releasePost();
    await first;
    await tick();

    expect(upload.reclaimed).toEqual([['local-a']]);
    expect(composer.editor).toEqual({ text: '', files: [fileA] });
  });

  test('a stash the host took returns nothing', async () => {
    let releasePost!: () => void;
    const slowPost = new Promise<void>((resolve) => (releasePost = resolve));
    const upload = heldUpload();
    const composer = composerAndHost(upload.controller, { slowPost });

    composer.type('first');
    const first = composer.submit();
    composer.type('second draft', [fileA]);
    await composer.submit();
    releasePost();
    await first;
    await tick();

    expect(composer.painted).toEqual(['first', 'second draft']);
    expect(upload.reclaimed).toEqual([]);
    expect(composer.editor).toEqual({ text: '', files: [] });
  });
});

describe('the composer submits through the latch', () => {
  test('handleSubmit goes through ONE latch instance, held in a ref', () => {
    // A latch rebuilt per render forgets it is in flight, which reopens the
    // same-tick double-fire window mid-send. The `??=` into a ref is what makes
    // the instance survive every render; the handler itself is stable (`[]`)
    // because its only inputs are refs.
    const wiring = between('const submitLatchRef = useRef', 'const editorPlaceholder');
    expect(wiring).toContain('submitLatchRef.current ??= createSubmitLatch<StashedDraft>(');
    expect(wiring).toContain('return submitLatchRef.current();');
    expect(wiring).toContain('}, []);');
  });

  test('the latch dispatches through a ref, so a deferred re-run reads fresh state', () => {
    // The deferred re-run fires after the in-flight send settles — an
    // arbitrarily later render. Dispatching the closure captured at latch
    // creation would submit against stale attachedFiles/queue props.
    const wiring = between('const dispatchSubmissionRef = useRef', 'const editorPlaceholder');
    expect(wiring).toContain('dispatchSubmissionRef.current = dispatchSubmission;');
    expect(wiring.replace(/\s+/g, ' ')).toContain(
      '(stash) => dispatchLatched( stash, (current) => dispatchSubmissionRef.current(current), promptAttachmentsRef.current, restoreStashedDraft, )',
    );
  });

  test('a stashed dispatch reports whether the host took the draft', () => {
    // Every refusal before the host is a bare `return;`, which `dispatchLatched`
    // reads as "give the stash back". Only three exits count as taken.
    const dispatch = between('const dispatchSubmission = useCallback(', 'const dispatchSubmissionRef = useRef');
    expect(dispatch).toContain('async (stash?: StashedDraft): Promise<DispatchOutcome> => {');
    expect(dispatch.match(/return 'sent';/g)).toHaveLength(2);
    expect(dispatch.match(/return 'answered';/g)).toHaveLength(1);
    const answer = between('if (lockForQuestion) {', 'const content = draft');
    expect(answer.indexOf('onCustomAnswer(trimmed);')).toBeLessThan(answer.indexOf("return 'answered';"));
    const restore = between('const restoreStashedDraft = (', 'submitLatchRef.current ??= createSubmitLatch');
    expect(restore).toContain('planFailedSendRecovery({');
    expect(restore).toContain('submittedDoc: withText ? stash.doc : null,');
    expect(restore).toContain('sentFiles: stash.files,');
  });

  test('the stash discriminator is typed text in the live editor, and the stash clears the editor', () => {
    // A double-fire arrives with the editor already cleared (dispatch clears it
    // synchronously); a distinct second message arrives with text. Files alone
    // must NOT arm the stash — un-flushed `attachedFiles` state is exactly
    // the hazard the latch exists to swallow. A stashed draft leaves the
    // editor at once, so the next Enter cannot merge into it.
    const wiring = between(
      'submitLatchRef.current ??= createSubmitLatch<StashedDraft>(',
      'const editorPlaceholder',
    );
    expect(wiring).toContain('if (!editor || !content || !content.text.trim()) return null;');
    expect(wiring).toContain('editor.clear();');
    expect(wiring).toContain('attachedFilesRef.current = [];');
    expect(wiring).toContain(
      'const attachmentSubmission = captureAttachmentSubmission(files, promptAttachmentsRef.current);',
    );
    expect(wiring).toContain('if (!attachmentSubmission) return null;');
    expect(wiring.indexOf('attachmentSubmission = captureAttachmentSubmission(')).toBeLessThan(
      wiring.indexOf('editor.clear();'),
    );
  });

  test('every submit entry point goes through the latched handler', () => {
    // The keyboard path and the button path must not diverge: a disabled button
    // does nothing to Enter, and a latch on only one of them guards neither.
    //
    // Counted over CODE only (comments reference the name without calling it).
    const refs = code().match(/\bdispatchSubmission\b/g) ?? [];

    // Exactly three: the definition, the `useRef(dispatchSubmission)` seed, and
    // the ref-mirror assignment. A fourth means something calls it unlatched.
    expect(refs).toHaveLength(3);
    expect(source).toContain('onSubmit={handleSubmit}');
  });

  test('Send captures, resets, clears the stored draft, then runs one runComposerSend', () => {
    const send = between('const content = draft', 'const dispatchSubmissionRef = useRef');
    const capture = send.indexOf('captureAttachmentSubmission(');
    const reset = send.indexOf('resolveComposerResetOnSend(');
    // Before the host runs: a reload while a send waits on its uploads must not
    // bring the sent text and files back into the composer.
    const clear = send.indexOf('clearSavedDraft();');
    const run = send.indexOf('await runComposerSend({');
    expect(capture).toBeGreaterThan(-1);
    expect(reset).toBeGreaterThan(capture);
    expect(clear).toBeGreaterThan(reset);
    expect(run).toBeGreaterThan(clear);
    expect(send.replace(/\s+/g, ' ')).toContain(
      'controller: promptAttachments, active: activeSubmissionIdsRef.current, send: () => onSend(trimmed, filesToSend, mentionsToSend, attachmentSubmission),',
    );
    // A refused send saves the restored draft again.
    expect(send.slice(send.indexOf('onFailed: () => {'))).toContain(
      'handleDocChange(restoredDoc, editorRef.current?.isEmpty() ?? true);',
    );
    // The host releases after its POST: the composer never forgets an upload.
    expect(code()).not.toContain('.forget(');
  });

  test('the composer never revokes a picture a Send took', () => {
    // Every composer revoke goes through the cache's guard.
    expect(code()).not.toContain('URL.revokeObjectURL(');
    expect(source).toContain('revokeUnsentPreview(url)');
  });

  test('the button and Enter refuse only a failed attachment', () => {
    const normalized = source.replace(/\s+/g, ' ');
    expect(normalized).toContain('const attachmentFailed = attachmentsBlockSend(promptAttachmentItems);');
    expect(normalized).toContain('submitDisabled || attachmentFailed ||');
    expect(normalized).toContain('attachmentFailed={attachmentFailed}');
    expect(source).toContain(
      'stash?.attachmentSubmission ?? captureAttachmentSubmission(filesNow, promptAttachments)',
    );
    expect(source).toContain('if (!attachmentSubmission) return;');
    expect(source).toContain('const filesNow = stash ? stash.files : attachedFilesRef.current;');
  });

  test('a plan or credit refusal at attach opens the billing path once per refusal', () => {
    expect(source.replace(/\s+/g, ' ')).toContain(
      'const [refusal] = takeNewBillingRefusals(promptAttachmentItems, seenBillingRefusalsRef.current); if (refusal) handleBillingError(refusal, tI18nComplete);',
    );
  });
});
