import { expect, test } from 'bun:test';
import { recoverTranscriptAttachments } from './session-transcript-attachments';
import { sessionAttachmentRef } from '@kortix/shared';

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
