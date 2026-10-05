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

  test('waits for the replacement composer to own the draft', () => {
    expect(shouldRestoreDraft({ ...ready, active: false })).toBe(false);
    expect(shouldRestoreDraft({ ...ready, active: true })).toBe(true);
  });
});

describe('reply quotes in the draft envelope', () => {
  test('an empty document with quotes is still worth storing', () => {
    const draft = serializeDraft({
      doc: EMPTY_DOC,
      documentIsEmpty: true,
      files: [],
      quotes: ['first passage'],
      userId: USER,
    });
    expect(draft?.quotes).toEqual(['first passage']);
  });

  test('quotes survive the round trip, in order', () => {
    const stored = serializeDraft({
      doc: TEXT_DOC,
      documentIsEmpty: false,
      files: [],
      quotes: ['first passage', 'second passage'],
      userId: USER,
    });
    const back = deserializeDraft(JSON.parse(JSON.stringify(stored)), USER);
    expect(back?.quotes).toEqual(['first passage', 'second passage']);
    expect(back?.doc).toEqual(TEXT_DOC);
  });

  test('an envelope written before quotes existed loads with an empty list', () => {
    const old = { v: DRAFT_ENVELOPE_VERSION, u: USER, doc: TEXT_DOC, files: [] };
    expect(deserializeDraft(old, USER)).toEqual({ ...old, quotes: [] });
  });

  test('malformed quotes are dropped, not trusted', () => {
    const bad = { v: DRAFT_ENVELOPE_VERSION, u: USER, doc: TEXT_DOC, files: [], quotes: 'no' };
    expect(deserializeDraft(bad, USER)?.quotes).toEqual([]);
    const mixed = { ...bad, quotes: ['kept', 7, '  ', null, 'kept'] };
    expect(deserializeDraft(mixed, USER)?.quotes).toEqual(['kept']);
  });

  test('legacy in-editor quote nodes become list quotes and leave the document', () => {
    // A draft saved by the build that drew quotes inside the editor. That
    // node type no longer exists in the schema, so it must not reach it.
    const legacy = {
      v: DRAFT_ENVELOPE_VERSION,
      u: USER,
      doc: {
        type: 'doc',
        content: [
          { type: 'replyQuote', attrs: { text: 'first passage' } },
          { type: 'paragraph', content: [{ type: 'text', text: 'reply one' }] },
          { type: 'replyQuote', attrs: { text: 'second passage' } },
          { type: 'paragraph' },
        ],
      },
      files: [],
    };
    const back = deserializeDraft(legacy, USER);
    expect(back?.quotes).toEqual(['first passage', 'second passage']);
    expect(back?.doc).toEqual({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'reply one' }] },
        { type: 'paragraph' },
      ],
    });
  });

  test('a document that held only legacy quotes keeps one empty paragraph', () => {
    const legacy = {
      v: DRAFT_ENVELOPE_VERSION,
      u: USER,
      doc: { type: 'doc', content: [{ type: 'replyQuote', attrs: { text: 'only passage' } }] },
      files: [],
      quotes: ['only passage'],
    };
    const back = deserializeDraft(legacy, USER);
    expect(back?.quotes).toEqual(['only passage']);
    expect(back?.doc).toEqual({ type: 'doc', content: [{ type: 'paragraph' }] });
  });
});
