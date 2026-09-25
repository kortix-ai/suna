import { expect, test } from 'bun:test';
import { recoverTranscriptAttachments } from './session-transcript-attachments';
import { sessionAttachmentRef } from '@kortix/shared';
import { stableSessionAttachmentId } from './session-attachment-identity';
import { mirrorRowsFromOpencodePayload } from './session-transcript-mirror';

const projectId = '11111111-1111-4111-8111-111111111111';
const sessionId = '22222222-2222-4222-8222-222222222222';
const row = (parts: Record<string, unknown>[]) => ({
  info: { id: 'msg_1', role: 'user' },
  parts,
});
const file = {
  id: 'p1',
  type: 'file',
  filename: 'photo.png',
  mime: 'image/png',
  url: 'data:image/png;base64,Ynl0ZXM=',
};
const text = {
  id: 'p2',
  type: 'text',
  text: 'Read this. <file path="/workspace/uploads/R&amp;D.txt" mime="text/plain" filename="R&amp;D.txt">Uploaded</file>',
};
function fixture() {
  const saved: Array<{ filename: string; bytes: Uint8Array }> = [];
  const paths: string[] = [];
  const warnings: string[] = [];
  const input = {
    projectId,
    sessionId,
    previous: new Map(),
    recover: true,
    readFile: async (path: string) => {
      paths.push(path);
      return new Uint8Array([1, 2, 3]);
    },
    saveFile: async (value: any) => {
      saved.push(value);
      return { url: sessionAttachmentRef(value) };
    },
    onFailure: (filename: string) => {
      warnings.push(filename);
    },
  };
  return { input, saved, paths, warnings };
}

test('recovers inline bytes and escaped workspace references without changing message or part identity', async () => {
  const f = fixture();
  const original = [row([file, text])];
  const result = await recoverTranscriptAttachments({
    ...f.input,
    messages: original,
  });
  expect(f.saved.map((value) => value.filename)).toEqual(['photo.png', 'R&D.txt']);
  expect(new TextDecoder().decode(f.saved[0]!.bytes)).toBe('bytes');
  expect(f.paths).toEqual(['/workspace/uploads/R&D.txt']);
  expect(result[0].info).toEqual(original[0].info);
  expect(result[0].parts.map((part: any) => part.id)).toEqual(['p1', 'p2']);
  expect(result[0].parts[0].url).toStartWith(`kortix-attachment://${projectId}/${sessionId}/`);
  expect(result[0].parts[1].text).toContain('attachment="kortix-attachment://');
  expect(original[0].parts).toEqual([file, text]);
});

test('reuses prior saved bytes without reading the sandbox, including after flag rollback', async () => {
  const f = fixture();
  const messages = [row([file, text])];
  const first = await recoverTranscriptAttachments({ ...f.input, messages });
  f.saved.length = 0;
  f.paths.length = 0;
  const previous = new Map([['msg_1', first[0].parts]]);
  const again = await recoverTranscriptAttachments({
    ...f.input,
    messages,
    previous,
    recover: false,
  });
  expect(again).toEqual(first);
  expect(f.saved).toHaveLength(0);
  expect(f.paths).toHaveLength(0);
});

test('missing files and storage failures preserve text and allow another capture to retry', async () => {
  const f = fixture();
  const messages = [row([file, text])];
  const failed = await recoverTranscriptAttachments({
    ...f.input,
    messages,
    saveFile: async () => {
      throw new Error('offline');
    },
    readFile: async () => null,
  });
  expect(failed).toEqual(messages);
  expect(f.warnings).toEqual(['photo.png', 'R&D.txt']);
  const retry = await recoverTranscriptAttachments({ ...f.input, messages });
  expect(retry[0].parts[0].url).toStartWith('kortix-attachment://');
});

test('never fetches remote URLs, non-workspace paths, or assistant-authored file tags', async () => {
  const f = fixture();
  const messages = [
    row([
      { ...file, url: 'https://private.invalid/file' },
      {
        ...text,
        text: '<file path="/workspace/../etc/secret" filename="secret">x</file>',
      },
    ]),
    { info: { id: 'msg_bot', role: 'assistant' }, parts: [text] },
  ];
  expect(await recoverTranscriptAttachments({ ...f.input, messages })).toEqual(messages);
  expect(f.saved).toHaveLength(0);
  expect(f.paths).toHaveLength(0);
});

test('same-named files have separate stable identities and retries reuse each identity', async () => {
  const f = fixture();
  const messages = [row([file, { ...file, id: 'p2' }])];
  const first = await recoverTranscriptAttachments({ ...f.input, messages });
  const second = await recoverTranscriptAttachments({ ...f.input, messages });
  expect(second).toEqual(first);
  expect(first[0].parts[0].url).not.toBe(first[0].parts[1].url);
});

test('disabled recovery leaves legacy files untouched', async () => {
  const f = fixture();
  const messages = [row([file, text])];
  expect(
    await recoverTranscriptAttachments({
      ...f.input,
      messages,
      recover: false,
    }),
  ).toEqual(messages);
  expect(f.saved).toHaveLength(0);
});

test('changed attachment bytes do not reuse the previous file reference', async () => {
  const f = fixture();
  const first = await recoverTranscriptAttachments({
    ...f.input,
    messages: [row([file])],
  });
  const result = await recoverTranscriptAttachments({
    ...f.input,
    previous: new Map([['msg_1', first[0].parts]]),
    messages: [row([{ ...file, url: 'data:image/png;base64,bmV3' }])],
  });
  expect(result[0].parts[0].url).not.toBe(first[0].parts[0].url);
});

test('recovery preserves distinct references within one text part', async () => {
  const f = fixture();
  const part = { ...text, text: text.text + text.text };
  const first = await recoverTranscriptAttachments({
    ...f.input,
    messages: [row([part])],
  });
  const refs = [...String(first[0].parts[0].text).matchAll(/attachment="([^"]+)"/g)].map(
    (m) => m[1],
  );
  expect(refs).toHaveLength(2);
  expect(refs[0]).not.toBe(refs[1]);
  f.saved.length = 0;
  const again = await recoverTranscriptAttachments({
    ...f.input,
    messages: [row([part])],
    previous: new Map([['msg_1', first[0].parts]]),
  });
  expect(again).toEqual(first);
  expect(f.saved).toHaveLength(0);
});

test('bounded reads cancel oversized bodies with and without a length header', async () => {
  const { readTranscriptAttachmentBytes } = await import('./session-transcript-attachments');
  const { MAX_SESSION_ATTACHMENT_BYTES } = await import('@kortix/shared');
  for (const headers of [new Headers(), new Headers({ 'content-length': String(MAX_SESSION_ATTACHMENT_BYTES + 1) })]) {
    let cancelled = false;
    const response = new Response(
      new ReadableStream({
        pull(controller) {
          controller.enqueue(new Uint8Array(1024 * 1024));
        },
        cancel() {
          cancelled = true;
        },
      }),
      { headers },
    );
    await expect(readTranscriptAttachmentBytes(response)).rejects.toThrow('exceeds 50 MiB');
    expect(cancelled).toBe(true);
  }
  expect(await readTranscriptAttachmentBytes(new Response(new Uint8Array([0, 1, 255])))).toEqual(
    new Uint8Array([0, 1, 255]),
  );
});

test('replaces temporary upload identities with one durable reference', async () => {
  const f = fixture();
  const part = { ...text, text: text.text.replace('<file ', '<file attachment="local_upload_1" ') };
  const messages = [row([part])];
  const result = await recoverTranscriptAttachments({ ...f.input, messages });
  const rendered = String(result[0].parts[0].text);
  expect(f.saved).toHaveLength(1);
  expect(rendered).not.toContain('local_upload_1');
  expect([...rendered.matchAll(/attachment="/g)]).toHaveLength(1);
  expect(rendered).toContain('attachment="kortix-attachment://');
  f.saved.length = 0;
  expect(await recoverTranscriptAttachments({
    ...f.input, messages, previous: new Map([['msg_1', result[0].parts]]), recover: false,
  })).toEqual(result);
  expect(f.saved).toHaveLength(0);
});

test('a user attachment keeps the exact reference it was stored under', async () => {
  // The id is derived from a key; changing that key's shape would stop every
  // stored reference from matching, and the next capture would re-read and
  // re-upload every file the session ever held.
  const f = fixture();
  const [message] = await recoverTranscriptAttachments({ ...f.input, messages: [row([file])] });
  const expected = sessionAttachmentRef({
    projectId,
    sessionId,
    attachmentId: stableSessionAttachmentId(
      `${sessionId}:msg_1:p1:file:photo.png:image/png:${file.url}`,
    ),
  });
  expect(message.parts[0].url).toBe(expected);
});

// ── Artifacts an agent SHOWED ──────────────────────────────────────────────

const assistant = (parts: Record<string, unknown>[]) => ({
  info: { id: 'msg_2', role: 'assistant' },
  parts,
});
const shown = (input: Record<string, unknown>, status = 'completed', tool = 'show') => ({
  id: 'p_show',
  type: 'tool',
  tool,
  callID: 'call_1',
  state: { status, title: 'Chart', input },
});

test('a shown workspace file is copied and the card records where', async () => {
  const f = fixture();
  const original = [assistant([{ id: 'p_text', type: 'text', text: 'Here it is.' }, shown({
    type: 'image',
    title: 'Revenue',
    path: '/workspace/out/revenue.png',
  })])];
  const [message] = await recoverTranscriptAttachments({ ...f.input, messages: original });
  expect(f.paths).toEqual(['/workspace/out/revenue.png']);
  expect(f.saved.map((value: any) => [value.filename, value.mime])).toEqual([
    ['revenue.png', 'image/png'],
  ]);
  const card = message.parts[1] as any;
  expect(card.state.input.attachment).toStartWith(`kortix-attachment://${projectId}/${sessionId}/`);
  // Everything else about the card is untouched — only the reference is added.
  expect(card.state.input.path).toBe('/workspace/out/revenue.png');
  expect(card.state.title).toBe('Chart');
  expect(message.info).toEqual(original[0].info);
  expect(message.parts.map((part: any) => part.id)).toEqual(['p_text', 'p_show']);
});

test('every carousel item is copied under its own reference, even from a JSON string', async () => {
  const f = fixture();
  const [message] = await recoverTranscriptAttachments({
    ...f.input,
    messages: [assistant([shown({
      items: JSON.stringify([
        { type: 'image', path: '/workspace/a.png' },
        { type: 'url', url: 'https://example.test' },
        { type: 'pdf', path: '/workspace/report.pdf' },
      ]),
    })])],
  });
  expect(f.paths).toEqual(['/workspace/a.png', '/workspace/report.pdf']);
  const items = (message.parts[0] as any).state.input.items;
  expect(items[0].attachment).toStartWith('kortix-attachment://');
  expect(items[1].attachment).toBeUndefined();
  expect(items[2].attachment).toStartWith('kortix-attachment://');
  expect(items[0].attachment).not.toBe(items[2].attachment);
  expect(f.saved.map((value: any) => value.mime)).toEqual(['image/png', 'application/pdf']);
});

test('only a settled, file-backed show inside the workspace is copied', async () => {
  const f = fixture();
  const untouched = [
    assistant([shown({ type: 'image', path: '/workspace/still-writing.png' }, 'running')]),
    assistant([shown({ type: 'url', url: 'https://example.test/page' })]),
    assistant([shown({ type: 'markdown', content: '# inline' })]),
    // A path that escapes the workspace is not the session's to copy.
    assistant([shown({ type: 'file', path: '/etc/passwd' })]),
    assistant([shown({ type: 'file', path: '/workspace/../etc/passwd' })]),
    // Not a show at all.
    assistant([{ id: 'p', type: 'tool', tool: 'read', state: { status: 'completed', input: { filePath: '/workspace/a.png' } } }]),
  ];
  const result = await recoverTranscriptAttachments({ ...f.input, messages: untouched });
  expect(f.paths).toEqual([]);
  expect(f.saved).toHaveLength(0);
  // Same objects back: a no-op is visibly a no-op.
  result.forEach((message, index) => expect(message).toBe(untouched[index] as any));
});

test('every spelling the SDK treats as show is copied', async () => {
  for (const tool of ['show', 'show_user', 'oc-show', 'show-user']) {
    const f = fixture();
    await recoverTranscriptAttachments({
      ...f.input,
      messages: [assistant([shown({ type: 'image', path: '/workspace/x.png' }, 'completed', tool)])],
    });
    expect(f.paths).toEqual(['/workspace/x.png']);
  }
});

test('a show copied by an earlier capture is not read again', async () => {
  const f = fixture();
  const messages = [assistant([shown({ type: 'image', path: '/workspace/out/revenue.png' })])];
  const [first] = await recoverTranscriptAttachments({ ...f.input, messages });
  expect(f.paths).toHaveLength(1);
  const [second] = await recoverTranscriptAttachments({
    ...f.input,
    messages,
    previous: new Map([['msg_2', first.parts]]),
  });
  expect(f.paths).toHaveLength(1);
  expect((second.parts[0] as any).state.input.attachment).toBe(
    (first.parts[0] as any).state.input.attachment,
  );
});

test('a Stop (no recovery) never reads a shown file', async () => {
  const f = fixture();
  await recoverTranscriptAttachments({
    ...f.input,
    recover: false,
    messages: [assistant([shown({ type: 'image', path: '/workspace/out/revenue.png' })])],
  });
  expect(f.paths).toEqual([]);
});

test('a shown file that is gone keeps its card and is retried next capture', async () => {
  const f = fixture();
  const messages = [assistant([shown({ type: 'image', path: '/workspace/deleted.png' })])];
  const result = await recoverTranscriptAttachments({
    ...f.input,
    messages,
    readFile: async (p: string) => {
      f.paths.push(p);
      return null;
    },
  });
  expect(f.warnings).toEqual(['deleted.png']);
  expect((result[0].parts[0] as any).state.input.attachment).toBeUndefined();
  expect(result[0]).toBe(messages[0] as any);
});

test('the recorded reference survives into the stored mirror row', async () => {
  // Recovery runs on the raw payload, THEN `mirrorRowsFromOpencodePayload`
  // sanitizes it. The pair is the real write path; either alone proves nothing.
  const f = fixture();
  const recovered = await recoverTranscriptAttachments({
    ...f.input,
    messages: [assistant([shown({
      type: 'image',
      title: 'Revenue',
      path: '/workspace/out/revenue.png',
    })])],
  });
  const [row] = mirrorRowsFromOpencodePayload(recovered);
  const input = (row.parts[0] as any).state.input;
  expect(input.attachment).toStartWith(`kortix-attachment://${projectId}/${sessionId}/`);
  expect(input.path).toBe('/workspace/out/revenue.png');
  expect(input.title).toBe('Revenue');
});

test('a pathological prompt cannot stall the capture', async () => {
  // Recovery scans user text for `<file>` tags synchronously, on the API's
  // event loop, at every capture. The regex it used took ~10 s on this input
  // (quadratic: each doubling quadrupled it) and stalled every request on the
  // process for that long. The text is whatever a user typed.
  const f = fixture();
  const evil = `${'<file\t'.repeat(40_000)}${'<file'}${'\t'.repeat(200_000)}`;
  const started = performance.now();
  await recoverTranscriptAttachments({
    ...f.input,
    messages: [row([{ id: 'p', type: 'text', text: evil }])],
  });
  expect(performance.now() - started).toBeLessThan(200);
  expect(f.paths).toEqual([]);
});
