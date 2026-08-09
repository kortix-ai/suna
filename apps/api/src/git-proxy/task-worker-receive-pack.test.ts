import { describe, expect, test } from 'bun:test';
import {
  TaskWorkerReceivePackError,
  completeTaskWorkerReceivePackResponse,
  inspectTaskWorkerReceivePack,
} from './task-worker-receive-pack';

const OLD = '1'.repeat(40);
const NEW = '2'.repeat(40);
const ZERO = '0'.repeat(40);
const encoder = new TextEncoder();

function pkt(payload: string): Uint8Array {
  const bytes = encoder.encode(payload);
  const header = (bytes.byteLength + 4).toString(16).padStart(4, '0');
  return encoder.encode(header + payload);
}

function request(commands: string[], pack = encoder.encode('PACKbody')): Uint8Array {
  const parts = [...commands.map(pkt), encoder.encode('0000'), pack];
  const size = parts.reduce((total, part) => total + part.byteLength, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function chunked(bytes: Uint8Array, cuts: number[]): ReadableStream<Uint8Array> {
  let offset = 0;
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset === bytes.byteLength) return controller.close();
      const end = Math.min(bytes.byteLength, offset + (cuts[index++] ?? bytes.byteLength));
      controller.enqueue(bytes.subarray(offset, end));
      offset = end;
    },
  });
}

async function inspect(bytes: Uint8Array, worker = 'worker-1') {
  return inspectTaskWorkerReceivePack({
    body: chunked(bytes, [1, 2, 3, 5, 8, 13, 21]),
    workerSessionId: worker,
    contentLength: String(bytes.byteLength),
  });
}

async function readAll(body: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(body).arrayBuffer());
}

describe('task worker receive-pack parser', () => {
  test('accepts one exact session branch command and replays every byte', async () => {
    const bytes = request([`${OLD} ${NEW} refs/heads/worker-1\0report-status side-band-64k`]);
    const parsed = await inspect(bytes);
    expect(parsed.command).toEqual({ oldOid: OLD, newOid: NEW, ref: 'refs/heads/worker-1' });
    expect(await readAll(parsed.body)).toEqual(bytes);
  });

  test('rejects another branch, a delete, and multiple commands', async () => {
    const cases = [
      request([`${OLD} ${NEW} refs/heads/main\0report-status`]),
      request([`${OLD} ${ZERO} refs/heads/worker-1\0report-status`]),
      request([
        `${OLD} ${NEW} refs/heads/worker-1\0report-status`,
        `${OLD} ${NEW} refs/heads/worker-1`,
      ]),
    ];
    for (const bytes of cases) {
      await expect(inspect(bytes)).rejects.toBeInstanceOf(TaskWorkerReceivePackError);
    }
  });

  test('rejects malformed, truncated, oversized-prelude, and oversized-body inputs', async () => {
    await expect(inspect(encoder.encode('zzzz'))).rejects.toThrow('pkt-line length');
    await expect(inspect(encoder.encode('0040short'))).rejects.toThrow('truncated');
    const valid = request([`${OLD} ${NEW} refs/heads/worker-1\0report-status`]);
    await expect(
      inspectTaskWorkerReceivePack({
        body: chunked(valid, [valid.byteLength]),
        workerSessionId: 'worker-1',
        maxPreludeBytes: 32,
        maxBodyBytes: 1024,
      }),
    ).rejects.toThrow('packet is too large');
    await expect(
      inspectTaskWorkerReceivePack({
        body: chunked(valid, [valid.byteLength]),
        workerSessionId: 'worker-1',
        contentLength: '2048',
        maxPreludeBytes: 256,
        maxBodyBytes: 1024,
      }),
    ).rejects.toThrow('body is too large');
  });

  test('enforces the streaming body bound after an accepted prelude', async () => {
    const bytes = request(
      [`${OLD} ${NEW} refs/heads/worker-1\0report-status`],
      encoder.encode('x'.repeat(128)),
    );
    const parsed = await inspectTaskWorkerReceivePack({
      body: chunked(bytes, [110, 32, 64, 64]),
      workerSessionId: 'worker-1',
      maxPreludeBytes: 128,
      maxBodyBytes: 150,
    });
    await expect(new Response(parsed.body).arrayBuffer()).rejects.toThrow('body is too large');
  });
});

describe('task worker receive-pack response completion', () => {
  test('replays a complete bounded provider result', async () => {
    const response = new Response(chunked(encoder.encode('status'), [2, 1, 3]), {
      status: 201,
      statusText: 'Created',
      headers: { 'x-git-result': 'complete' },
    });
    const completed = await completeTaskWorkerReceivePackResponse(response, 6);
    expect(completed.status).toBe(201);
    expect(completed.headers.get('x-git-result')).toBe('complete');
    expect(await completed.text()).toBe('status');
  });

  test('does not confirm an oversized provider result', async () => {
    const response = new Response(chunked(encoder.encode('status'), [2, 2, 2]));
    await expect(completeTaskWorkerReceivePackResponse(response, 5)).rejects.toThrow(
      'response body is too large',
    );
  });
});
