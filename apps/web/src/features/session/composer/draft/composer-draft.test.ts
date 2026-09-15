import type { JSONContent } from '@tiptap/core';
import { describe, expect, test } from 'bun:test';

import type { AttachedFile } from '../types';
import {
  DRAFT_ENVELOPE_VERSION,
  MAX_DRAFT_BYTES,
  deserializeDraft,
  draftScopeKey,
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
