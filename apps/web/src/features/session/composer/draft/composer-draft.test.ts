import type { JSONContent } from '@tiptap/core';
import { describe, expect, test } from 'bun:test';

import type { PromptAttachmentSnapshot, SessionPromptPart } from '@kortix/sdk';
import { stageFirstPromptAttachments } from '../../uploaded-file-refs';
import { captureAttachmentSubmission } from '../attachment-submission';
import type { AttachedFile } from '../types';
import {
  DRAFT_ENVELOPE_VERSION,
  MAX_DRAFT_BYTES,
  deserializeDraft,
  draftScopeKey,
  restoreDraftFileOrder,
  serializeDraft,
  shouldRestoreDraft,
  type StoredDraft,
} from './composer-draft';

const USER = 'user-aaa';
const OTHER_USER = 'user-bbb';

const EMPTY_DOC: JSONContent = { type: 'doc', content: [{ type: 'paragraph' }] };

const TEXT_DOC: JSONContent = {
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'ship it' }] }],
};

/** A document whose paragraph holds a `mention` ATOM node, not text. */
const MENTION_DOC: JSONContent = {
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'look at ' },
        { type: 'mention', attrs: { kind: 'file', label: 'README.md', value: 'README.md' } },
      ],
    },
  ],
};

const REMOTE_FILE: AttachedFile = {
  kind: 'remote',
  url: 'https://example.test/a.png',
  filename: 'a.png',
  mime: 'image/png',
  isImage: true,
};

const LOCAL_FILE: AttachedFile = {
  kind: 'local',
  file: new File(['x'], 'b.png', { type: 'image/png' }),
  localUrl: 'blob:local-b',
  isImage: true,
};

describe('draftScopeKey', () => {
  test('project and session scopes produce distinct, prefixed keys', () => {
    expect(draftScopeKey({ kind: 'project', projectId: 'p1' })).toBe('project:p1');
    expect(draftScopeKey({ kind: 'session', sessionId: 'p1' })).toBe('session:p1');
  });
});

describe('serializeDraft', () => {
  test('an empty document with no remote files stores nothing', () => {
    expect(
      serializeDraft({ doc: EMPTY_DOC, documentIsEmpty: true, files: [], userId: USER }),
    ).toBeNull();
  });

  test('an empty document WITH a remote file is still worth storing', () => {
    const draft = serializeDraft({
      doc: EMPTY_DOC,
      documentIsEmpty: true,
      files: [REMOTE_FILE],
      userId: USER,
    });
    expect(draft?.files).toEqual([REMOTE_FILE]);
  });

  test('local attachments are dropped, remote ones are kept', () => {
    const draft = serializeDraft({
      doc: TEXT_DOC,
      documentIsEmpty: false,
      files: [LOCAL_FILE, REMOTE_FILE],
      userId: USER,
    });
    expect(draft?.files).toEqual([REMOTE_FILE]);
  });

  test('stores canonical completed metadata without local bytes or URLs', () => {
    const attachment = {
      attachment_id: 'att-ready',
      filename: 'ready.txt',
      mime: 'text/plain',
      size: 5,
      expires_at: '2099-01-01T00:00:00.000Z',
    };
    const draft = serializeDraft({
      doc: EMPTY_DOC,
      documentIsEmpty: true,
      files: [LOCAL_FILE],
      attachments: [{ ...attachment, uploadId: 'local-ready' }],
      userId: USER,
    });

    expect(draft?.attachments).toEqual([attachment]);
    const serialized = JSON.stringify(draft);
    expect(serialized).not.toContain('blob:');
    expect(serialized).not.toContain('data:');
    expect(serialized).not.toContain('signed');
  });

  test('stamps the envelope version and the author user id', () => {
    const draft = serializeDraft({
      doc: TEXT_DOC,
      documentIsEmpty: false,
      files: [],
      userId: USER,
    });
    expect(draft?.v).toBe(DRAFT_ENVELOPE_VERSION);
    expect(draft?.u).toBe(USER);
  });

  test('a signed-out caller (no user id) stores nothing', () => {
    expect(
      serializeDraft({ doc: TEXT_DOC, documentIsEmpty: false, files: [], userId: '' }),
    ).toBeNull();
  });

  test('a draft over the size cap is refused rather than stored', () => {
    const huge: JSONContent = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'x'.repeat(MAX_DRAFT_BYTES + 1) }] },
      ],
    };
    expect(
      serializeDraft({ doc: huge, documentIsEmpty: false, files: [], userId: USER }),
    ).toBeNull();
  });
});

describe('deserializeDraft', () => {
  test('a mention atom node survives the round trip intact', () => {
    const stored = serializeDraft({
      doc: MENTION_DOC,
      documentIsEmpty: false,
      files: [],
      userId: USER,
    });
    const back = deserializeDraft(JSON.parse(JSON.stringify(stored)), USER);
    // The regression guard for the whole feature: storing text instead of the
    // document would flatten this atom to the literal string "@README.md" and
    // the next send would carry no <file_ref> block.
    expect(back?.doc.content?.[0]?.content?.[1]).toEqual({
      type: 'mention',
      attrs: { kind: 'file', label: 'README.md', value: 'README.md' },
    });
  });

  test('a draft written by another user is refused', () => {
    const stored = serializeDraft({
      doc: TEXT_DOC,
      documentIsEmpty: false,
      files: [],
      userId: USER,
    });
    expect(deserializeDraft(stored, OTHER_USER)).toBeNull();
  });

  test('restores only valid unexpired completed metadata', () => {
    const raw = {
      v: DRAFT_ENVELOPE_VERSION,
      u: USER,
      doc: EMPTY_DOC,
      files: [],
      attachments: [
        {
          attachment_id: 'att-ready',
          filename: 'ready.txt',
          mime: 'text/plain',
          size: 5,
          expires_at: '2099-01-01T00:00:00.000Z',
          url: 'https://signed.example/private',
        },
        {
          attachment_id: 'att-expired',
          filename: 'expired.txt',
          mime: 'text/plain',
          size: 5,
          expires_at: '2020-01-01T00:00:00.000Z',
        },
      ],
      order: [{ kind: 'attachment', attachmentId: 'att-ready' }],
    };

    expect(deserializeDraft(raw, USER)?.attachments).toEqual([
      {
        attachment_id: 'att-ready',
        filename: 'ready.txt',
        mime: 'text/plain',
        size: 5,
        expires_at: '2099-01-01T00:00:00.000Z',
      },
    ]);
  });

  test('preserves interleaved staged and remote attachment order without private bytes', () => {
    const attachment = {
      attachment_id: 'att-ready',
      filename: 'first.png',
      mime: 'image/png',
      size: 1,
      expires_at: '2099-01-01T00:00:00.000Z',
    };
    const staged: AttachedFile = {
      kind: 'staged',
      uploadId: 'local-ready',
      attachment,
      filename: attachment.filename,
      mime: attachment.mime,
      isImage: true,
    };
    const stored = serializeDraft({
      doc: EMPTY_DOC,
      documentIsEmpty: true,
      files: [staged, REMOTE_FILE],
      attachments: [{ ...attachment, uploadId: staged.uploadId }],
      userId: USER,
    });
    const back = deserializeDraft(JSON.parse(JSON.stringify(stored)), USER);
    expect(back?.order).toEqual([
      { kind: 'attachment', attachmentId: 'att-ready' },
      { kind: 'remote', index: 0 },
    ]);
    if (!back) throw new Error('expected stored draft');
    expect(
      restoreDraftFileOrder(back, (item) => ({
        kind: 'staged',
        uploadId: `restored-${item.attachment_id}`,
        attachment: item,
        filename: item.filename,
        mime: item.mime,
        isImage: item.mime.startsWith('image/'),
      })).map((file) => (file.kind === 'local' ? file.file.name : file.filename)),
    ).toEqual(['first.png', 'a.png']);
    expect(JSON.stringify(back)).not.toContain('blob:');
  });

  test('preserves mixed attachment order through save, reload, capture, and Send', async () => {
    const firstAttachment = {
      attachment_id: 'att-first',
      filename: 'first.bin',
      mime: 'application/octet-stream',
      size: 5,
      expires_at: '2099-01-01T00:00:00.000Z',
    };
    const thirdAttachment = {
      attachment_id: 'att-third',
      filename: 'third_.txt',
      mime: 'text/plain',
      size: 5,
      expires_at: '2099-01-01T00:00:00.000Z',
    };
    const first: AttachedFile = {
      kind: 'local',
      uploadId: 'before-reload-first',
      file: new File(['first'], 'first.bin'),
      localUrl: 'blob:first',
      isImage: false,
    };
    const third: AttachedFile = {
      kind: 'local',
      uploadId: 'before-reload-third',
      file: new File(['third'], 'third?.txt', { type: 'text/plain; charset=utf-8' }),
      localUrl: 'blob:third',
      isImage: false,
    };
    // Identical display metadata belongs to distinct uploads. Controller
    // completion order below deliberately differs from the tray order.
    const fourthAttachment = { ...thirdAttachment, attachment_id: 'att-fourth' };
    const fourth: AttachedFile = { ...third, uploadId: 'before-reload-fourth' };
    const stored = serializeDraft({
      doc: EMPTY_DOC,
      documentIsEmpty: true,
      files: [first, REMOTE_FILE, third, REMOTE_FILE, fourth],
      attachments: [
        { ...fourthAttachment, uploadId: fourth.uploadId },
        { ...thirdAttachment, uploadId: third.uploadId },
        { ...firstAttachment, uploadId: first.uploadId },
      ],
      userId: USER,
    });
    const back = deserializeDraft(JSON.parse(JSON.stringify(stored)), USER);
    if (!back) throw new Error('expected stored draft');
    const restored = restoreDraftFileOrder(back, (attachment) => ({
      kind: 'staged',
      uploadId: `restored-${attachment.attachment_id}`,
      attachment,
      filename: attachment.filename,
      mime: attachment.mime,
      isImage: attachment.mime.startsWith('image/'),
    }));
    const readyParts: SessionPromptPart[] = [firstAttachment, thirdAttachment, fourthAttachment].map(
      (attachment) => ({
        type: 'file',
        attachment_id: attachment.attachment_id,
        filename: attachment.filename,
        mime: attachment.mime,
      }),
    );
    const snapshot: PromptAttachmentSnapshot = {
      canSend: true,
      attachments: [firstAttachment, thirdAttachment, fourthAttachment].map((attachment) => ({
        id: `restored-${attachment.attachment_id}`,
        filename: attachment.filename,
        mime: attachment.mime,
        size: attachment.size,
        status: 'ready',
        receivedBytes: attachment.size,
        attachment,
      })),
    };
    const captured = captureAttachmentSubmission(restored, {
      getReadyParts: () => readyParts,
      getSnapshot: () => snapshot,
    });
    const sent = await stageFirstPromptAttachments(restored, captured.parts);

    expect(
      restored.map((file) => (file.kind === 'local' ? file.file.name : file.filename)),
    ).toEqual(['first.bin', 'a.png', 'third_.txt', 'a.png', 'third_.txt']);
    expect(captured.submittedIds).toEqual(['restored-att-first', 'restored-att-third', 'restored-att-fourth']);
    expect(sent.map((part) => part.filename)).toEqual(['first.bin', 'a.png', 'third_.txt', 'a.png', 'third_.txt']);
    expect(sent.map((part) => part.attachment_id ?? part.url)).toEqual([
      'att-first',
      REMOTE_FILE.kind === 'remote' ? REMOTE_FILE.url : '',
      'att-third',
      REMOTE_FILE.kind === 'remote' ? REMOTE_FILE.url : '',
      'att-fourth',
    ]);
    const serialized = JSON.stringify(back);
    for (const forbidden of ['blob:', 'data:', 'uploadId', 'third?', 'charset=', 'signed']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  test('a stale envelope version is refused', () => {
    const stale = { v: 0, u: USER, doc: TEXT_DOC, files: [] } as unknown as StoredDraft;
    expect(deserializeDraft(stale, USER)).toBeNull();
  });

  test('malformed input is refused rather than thrown on', () => {
    expect(deserializeDraft(null, USER)).toBeNull();
    expect(deserializeDraft('not an object', USER)).toBeNull();
    expect(deserializeDraft({ v: 1, u: USER }, USER)).toBeNull();
    expect(deserializeDraft({ v: 1, u: USER, doc: TEXT_DOC, files: 'no' }, USER)).toBeNull();
  });

  test('an empty current user id refuses every draft', () => {
    const stored = serializeDraft({
      doc: TEXT_DOC,
      documentIsEmpty: false,
      files: [],
      userId: USER,
    });
    expect(deserializeDraft(stored, '')).toBeNull();
  });
});

describe('shouldRestoreDraft — precedence', () => {
  const ready = {
    editorReady: true,
    editorIsEmpty: true,
    hasPrefill: false,
    alreadyRestored: false,
  };

  test('restores on ready + empty + no prefill + not yet restored', () => {
    expect(shouldRestoreDraft(ready)).toBe(true);
  });

  test('a prefill wins over a stored draft', () => {
    expect(shouldRestoreDraft({ ...ready, hasPrefill: true })).toBe(false);
  });

  test('never restores twice for one scope', () => {
    expect(shouldRestoreDraft({ ...ready, alreadyRestored: true })).toBe(false);
  });

  test('never overwrites text already in the editor', () => {
    expect(shouldRestoreDraft({ ...ready, editorIsEmpty: false })).toBe(false);
  });

  test('waits for the editor to be ready', () => {
    expect(shouldRestoreDraft({ ...ready, editorReady: false })).toBe(false);
  });
});
