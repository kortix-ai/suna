import { afterEach, describe, expect, test } from 'bun:test';
import { serializePromptWithPastes, splitPastedContent } from '@kortix/shared';
import { cleanPromptText, type QueueRow } from './queue-projection';
import {
  cancelQueuedPromptEdit,
  type QueuedPromptEditHost,
  saveQueuedPromptEdit,
  takeBackQueuedPrompt,
  useQueuedPromptEditStore,
} from './queued-prompt-edit';
import { uploadedFileRefXml } from './uploaded-file-refs';

const KEY = '00000000-0000-4000-8000-0000000000e1';
// What the send path stores for a queued message with a file: the typed words,
// then the upload reference the composer appends (`uploaded-file-refs.ts`).
const FILE_REF = uploadedFileRefXml({
  path: '/workspace/uploads/.kortix-inbox/report.pdf',
  filename: 'report.pdf',
  mime: 'application/pdf',
});
const RAW_WITH_FILE = `please review the attached report\n\n${FILE_REF}`;

function row(overrides: Partial<QueueRow> = {}): QueueRow {
  return {
    id: 'prompt-1',
    clientMessageId: 'client-1',
    text: 'please review the attached report',
    attachmentCount: 1,
    state: 'queued',
    removable: true,
    retryable: false,
    interruptible: true,
    takeBackEligible: true,
    rawText: RAW_WITH_FILE,
    editText: 'please review the attached report',
    ...overrides,
  };
}

interface Calls {
  edits: Array<{ promptId: string; text: string }>;
  composer: string[];
  forgotten: string[];
  errors: string[];
}

function host(rows: readonly QueueRow[], editPrompt?: QueuedPromptEditHost['editPrompt']) {
  const calls: Calls = { edits: [], composer: [], forgotten: [], errors: [] };
  const h: QueuedPromptEditHost = {
    key: KEY,
    rows: () => rows,
    editPrompt:
      editPrompt ??
      (async (promptId, text) => {
        calls.edits.push({ promptId, text });
      }),
    setComposerText: (text) => calls.composer.push(text),
    forgetLocalDraft: (clientMessageId) => calls.forgotten.push(clientMessageId),
    onError: (message) => calls.errors.push(message),
  };
  return { h, calls };
}

afterEach(() => useQueuedPromptEditStore.setState({ edits: {} }));

test('the fixture is what the queue projection derives from a sent message with a file', () => {
  expect(cleanPromptText(RAW_WITH_FILE)).toEqual({
    text: 'please review the attached report',
    fileCount: 1,
  });
});

describe('Edit opens a queued message in place', () => {
  test('the words reach the composer and no request is sent: the row and its files stay queued', () => {
    const { h, calls } = host([row()]);

    expect(takeBackQueuedPrompt(h, 'prompt-1')).toBe(true);

    expect(calls.composer).toEqual(['please review the attached report']);
    expect(calls.edits).toEqual([]);
    expect(useQueuedPromptEditStore.getState().edits[KEY]?.promptId).toBe('prompt-1');
  });

  test('Up with no id opens the latest editable row', () => {
    const { h } = host([
      row({ id: 'older', clientMessageId: 'c-older' }),
      row({ id: 'newer', clientMessageId: 'c-newer' }),
      row({ id: 'sending', state: 'sending', takeBackEligible: false }),
    ]);

    expect(takeBackQueuedPrompt(h)).toBe(true);
    expect(useQueuedPromptEditStore.getState().edits[KEY]?.promptId).toBe('newer');
  });

  test('a row that cannot be edited is refused, and one edit at a time', () => {
    const { h, calls } = host([row(), row({ id: 'prompt-2', takeBackEligible: false })]);

    expect(takeBackQueuedPrompt(h, 'prompt-2')).toBe(false);
    expect(takeBackQueuedPrompt(h, 'prompt-1')).toBe(true);
    expect(takeBackQueuedPrompt(h, 'prompt-1')).toBe(false);
    expect(calls.composer).toHaveLength(1);
  });
});

describe('Submit saves the edit into the same row', () => {
  test('only the edited words change; the file reference after them survives', async () => {
    const { h, calls } = host([row()]);
    takeBackQueuedPrompt(h, 'prompt-1');

    expect(await saveQueuedPromptEdit(h, '  please summarise the attached report  ')).toBe(true);

    expect(calls.edits).toEqual([
      {
        promptId: 'prompt-1',
        text: `please summarise the attached report\n\n${FILE_REF}`,
      },
    ]);
    // This tab's own copy of the text outranks the server's row, so it goes.
    expect(calls.forgotten).toEqual(['client-1']);
    expect(useQueuedPromptEditStore.getState().edits[KEY]).toBeUndefined();
  });

  test('typed words that also occur inside a paste: the typed run changes, the paste survives', async () => {
    // Pastes are written BEFORE the typed text, so the first match is inside the paste body.
    const raw = serializePromptWithPastes('fix the bug', [{ id: 'abcd1234', text: 'notes: fix the bug soon' }]);
    const cleaned = cleanPromptText(raw);
    expect(cleaned.text).toBe('fix the bug');
    const { h, calls } = host([row({ rawText: raw, editText: cleaned.text, text: cleaned.text })]);
    takeBackQueuedPrompt(h, 'prompt-1');

    expect(await saveQueuedPromptEdit(h, 'fix the crash')).toBe(true);

    const sent = calls.edits[0].text;
    expect(sent).toBe(serializePromptWithPastes('fix the crash', [{ id: 'abcd1234', text: 'notes: fix the bug soon' }]));
    expect(splitPastedContent(sent)).toEqual({
      text: 'fix the crash',
      pastes: [{ id: 'abcd1234', text: 'notes: fix the bug soon' }],
    });
  });

  test('unchanged words close the edit without a request', async () => {
    const { h, calls } = host([row()]);
    takeBackQueuedPrompt(h, 'prompt-1');

    expect(await saveQueuedPromptEdit(h, 'please review the attached report')).toBe(true);

    expect(calls.edits).toEqual([]);
    expect(useQueuedPromptEditStore.getState().edits[KEY]).toBeUndefined();
  });

  test('with no edit open, Submit is not handled here: the composer sends as usual', async () => {
    const { h, calls } = host([row()]);

    expect(await saveQueuedPromptEdit(h, 'a new message')).toBe(false);
    expect(calls.edits).toEqual([]);
  });

  test('a refused save (409: the agent already has it) gives the words back to the composer', async () => {
    const { h, calls } = host([row()], async () => {
      throw new Error('Prompt is already with the agent');
    });
    takeBackQueuedPrompt(h, 'prompt-1');

    expect(await saveQueuedPromptEdit(h, 'please summarise it')).toBe(true);

    expect(calls.composer).toEqual(['please review the attached report', 'please summarise it']);
    expect(calls.errors).toEqual(['Prompt is already with the agent']);
    expect(useQueuedPromptEditStore.getState().edits[KEY]).toBeUndefined();
  });
});

describe('Cancel and hand-over', () => {
  test('Cancel empties the composer and sends nothing: the row was never touched', () => {
    const { h, calls } = host([row()]);
    takeBackQueuedPrompt(h, 'prompt-1');

    cancelQueuedPromptEdit(h);

    expect(calls.composer).toEqual(['please review the attached report', '']);
    expect(calls.edits).toEqual([]);
    expect(useQueuedPromptEditStore.getState().edits[KEY]).toBeUndefined();
  });

  test('an edit opened by the boot shell is saved by the chat that replaces it, never sent as a new message', async () => {
    const shell = host([row()]);
    takeBackQueuedPrompt(shell.h, 'prompt-1');

    // The chat mounts under the same project session id and owns Submit now.
    const chat = host([row()]);
    expect(await saveQueuedPromptEdit(chat.h, 'please summarise the attached report')).toBe(true);

    expect(chat.calls.edits).toHaveLength(1);
    expect(chat.calls.edits[0]?.promptId).toBe('prompt-1');
  });

  test('edits are per session', () => {
    const { h } = host([row()]);
    takeBackQueuedPrompt(h, 'prompt-1');

    const other = host([row()]);
    other.h.key = '00000000-0000-4000-8000-0000000000e2';
    expect(takeBackQueuedPrompt(other.h, 'prompt-1')).toBe(true);
  });
});
