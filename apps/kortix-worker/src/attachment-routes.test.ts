import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { fauxAssistantMessage } from '@earendil-works/pi-ai';
import { startWorker } from './worker.ts';
import { mintWireMessageId } from './wire-message-id.ts';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9l8AAAAASUVORK5CYII=',
  'base64',
);
const sha256 = createHash('sha256').update(png).digest('hex');
const file = {
  type: 'file',
  mime: 'image/png',
  filename: 'sample.png',
  url: `kortix-attachment:sha256:${sha256}`,
};
const workers: Awaited<ReturnType<typeof startWorker>>[] = [];
const stores: ReturnType<typeof Bun.serve>[] = [];
afterEach(async () => {
  for (const worker of workers.splice(0)) {
    worker.server.closeAllConnections();
    await worker.close();
  }
  for (const store of stores.splice(0)) store.stop(true);
});
async function fixture() {
  const items: any[] = [];
  const reads: string[] = [];
  let missing = false;
  let hold: Promise<void> | undefined;
  let release: (() => void) | undefined;
  const store = Bun.serve({
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path.includes('/attachments/')) {
        reads.push(path);
        if (hold) await hold;
        if (missing || !path.endsWith(sha256)) return new Response(null, { status: 404 });
        return new Response(png, { headers: { 'content-type': 'image/png' } });
      }
      if (request.method === 'GET') return Response.json(items);
      const item = await request.json();
      const id = request.headers.get('idempotency-key');
      if (!id || !items.some((row) => row._kortixAppendId === id)) items.push(item);
      return new Response(null, { status: 204 });
    },
  });
  stores.push(store);
  const cfg = {
    port: 0,
    envUrl: 'http://127.0.0.1:1',
    envUrlExplicit: true,
    envCwd: '/workspace',
    systemPrompt: 'Follow the request.',
    modelMode: 'faux' as const,
    sessionId: 'images',
    kortixToken: 'test-token',
    storeUrl: store.url.toString().replace(/\/$/, ''),
    turnOwnerLeaseMs: 500,
    turnOwnerHeartbeatMs: 50,
  };
  let worker = await startWorker(cfg);
  workers.push(worker);
  const request = (path: string, body?: unknown) =>
    fetch(`http://127.0.0.1:${worker.port}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const id = (await (await request('/session')).json())[0].id;
  return {
    items,
    reads,
    id,
    get worker() {
      return worker;
    },
    setMissing() {
      missing = true;
    },
    holdRead() {
      hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => release?.();
    },
    request,
    send: (body: any) =>
      request(`/session/${id}/message`, {
        parts: [{ type: 'text', text: 'Describe this image.' }, file],
        ...body,
      }),
    history: async () => (await request(`/session/${id}/message`)).json() as Promise<any[]>,
    async restart() {
      await worker.close();
      worker = await startWorker(cfg);
      workers.push(worker);
    },
  };
}

test('immutable images reach the model, remain lazy in wire history, and replay after replacement', async () => {
  const f = await fixture();
  const contexts: any[][] = [];
  const convert = f.worker.agent.convertToLlm;
  f.worker.agent.convertToLlm = async (messages) => {
    const result = await convert(messages);
    contexts.push(structuredClone(result));
    return result;
  };
  f.worker.faux!.setResponses([fauxAssistantMessage('An image.')]);
  const initial = await f.send({});
  if (initial.status !== 200) throw new Error(await initial.text());
  expect(initial.status).toBe(200);
  const answer = await initial.json();
  expect(answer.info.error).toBeUndefined();
  expect(answer.parts.some((part: any) => part.type === 'text' && part.text === 'An image.')).toBe(
    true,
  );
  const input = contexts[0]!.find((message) => message.role === 'user');
  expect(input.content.find((part: any) => part.type === 'image')).toMatchObject({
    data: png.toString('base64'),
    mimeType: 'image/png',
  });
  const before = await f.history();
  expect(before).toHaveLength(2);
  const attachment = before[0].parts.find((part: any) => part.type === 'file');
  expect(attachment).toMatchObject({ mime: 'image/png', filename: 'sample.png' });
  expect(attachment.url).toBe(`/kortix/part/${f.id}/${before[0].info.id}/${attachment.id}`);
  const bytes = await f.request(attachment.url);
  expect(bytes.status).toBe(200);
  expect(Buffer.from(await bytes.arrayBuffer())).toEqual(png);
  expect(JSON.stringify(f.items)).not.toContain(png.toString('base64'));
  await f.restart();
  expect(await f.history()).toEqual(before);
  expect(Buffer.from(await (await f.request(attachment.url)).arrayBuffer())).toEqual(png);
  const restored = await f.worker.agent.convertToLlm(f.worker.agent.state.messages);
  expect(
    (restored.find((message) => message.role === 'user')!.content as any[]).find(
      (part) => part.type === 'image',
    ).data,
  ).toBe(png.toString('base64'));
  expect(f.worker.env.calls).toHaveLength(0);
});

test('image-only noReply prompts persist and retries retain their attachment identity', async () => {
  const f = await fixture();
  const messageID = mintWireMessageId({ nowMs: Date.now() }).id;
  const body = { messageID, noReply: true, parts: [file] };
  expect((await f.send(body)).status).toBe(200);
  const before = await f.history();
  expect(before).toHaveLength(1);
  expect(before[0].parts.filter((part: any) => part.type === 'file')).toHaveLength(1);
  expect((await f.send(body)).status).toBe(200);
  expect((await f.send({ ...body, parts: [{ ...file, filename: 'renamed.png' }] })).status).toBe(
    409,
  );
  await f.restart();
  expect(await f.history()).toEqual(before);
  expect(f.worker.faux!.state.callCount).toBe(0);
});

test('missing assets and untrusted URLs fail before prompt acceptance or environment access', async () => {
  const f = await fixture();
  for (const url of [
    'https://example.com/image.png',
    'file:///etc/passwd',
    'kortix-attachment:sha256:invalid',
  ]) {
    expect((await f.send({ parts: [{ ...file, url }] })).status).toBe(400);
  }
  expect((await f.send({ parts: [{ ...file, mime: 'application/pdf' }] })).status).toBe(400);
  f.setMissing();
  expect((await f.send({})).status).toBe(400);
  expect(await f.history()).toEqual([]);
  expect(f.worker.env.calls).toHaveLength(0);
  expect(f.worker.faux!.state.callCount).toBe(0);
});

test('a text-only model rejects an image before reading assets or creating a turn', async () => {
  const f = await fixture();
  f.worker.agent.state.model!.input = ['text'];
  const response = await f.send({});
  expect(response.status).toBe(400);
  expect((await response.json()).error).toContain('does not accept image');
  expect(f.reads).toEqual([]);
  expect(await f.history()).toEqual([]);
});

test('lazy attachment reads require runtime authorization and a visible matching part', async () => {
  const f = await fixture();
  expect((await f.send({ noReply: true })).status).toBe(200);
  const history = await f.history();
  const part = history[0].parts.find((part: any) => part.type === 'file');
  expect((await fetch(`http://127.0.0.1:${f.worker.port}${part.url}`)).status).toBe(401);
  expect((await f.request(part.url + 'wrong')).status).toBe(404);
  expect((await f.request(part.url.replace(f.id, 'other-session'))).status).toBe(404);
  const response = await f.request(part.url);
  expect(response.status).toBe(200);
  expect(response.headers.get('etag')).toBe(`"${sha256}"`);
});

test('Stop cancels image validation before acceptance and does not execute the prompt later', async () => {
  const f = await fixture();
  const release = f.holdRead();
  const pending = f.send({});
  try {
    const deadline = Date.now() + 2_000;
    while (!f.reads.length && Date.now() < deadline) await Bun.sleep(5);
    expect(f.reads).toHaveLength(1);
    const stopped = await f.request(`/session/${f.id}/abort`, {});
    expect(stopped.status).toBe(200);
    expect((await pending).status).toBe(409);
    release();
    expect(await f.history()).toEqual([]);
    expect(f.worker.faux!.state.callCount).toBe(0);
    expect(f.worker.env.calls).toHaveLength(0);
  } finally {
    release();
    await pending;
  }
});

test('the worker advertises its pinned model image capability', async () => {
  const f = await fixture();
  const config = await (await f.request('/config')).json();
  const [provider, ...model] = config.model.split('/');
  expect(config.provider[provider].models[model.join('/')].attachment).toBe(true);
});
