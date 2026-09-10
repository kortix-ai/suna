/**
 * Session attachment admission — the deterministic control-plane half of
 * SESS-27. Browser evidence owns attachment tiles, reload timestamps, and turn
 * duration. The focused API tests own runtime write-failure injection. This
 * flow proves that the public warm-session claim boundary durably accepts one
 * ordered mixed batch before runtime readiness and leaves the unused session
 * retryable when staged non-native bytes are absent.
 */
import { flow } from '../core/flow';
import {
  bindDatabaseSessionCredential,
  createDatabaseSession,
} from '../fixtures/database-project';

flow('SESS-28', {
  domain: 'sessions', requires: ['database'], timeoutMs: 180_000,
  routes: [
    'POST /v1/projects/:projectId/attachments',
    'PUT /v1/projects/:projectId/attachments/:attachmentId/chunks/:index',
    'POST /v1/projects/:projectId/attachments/:attachmentId/complete',
    'DELETE /v1/projects/:projectId/attachments/:attachmentId',
    'POST /v1/projects/:projectId/sessions/warm/claim',
    'POST /v1/projects/:projectId/sessions/:sessionId/prompts',
    'GET /v1/projects/:projectId/sessions/:sessionId/prompts',
    'GET /v1/projects/:projectId/sessions/:sessionId',
    'GET /v1/projects/:projectId/runtime/prompt-attachments/:attachmentId',
    'POST /v1/projects/:projectId/cli-token',
    'DELETE /v1/projects/:projectId/cli-token/:tokenId',
  ],
}, async (ctx) => {
  const project = await ctx.fixtures.project();
  const owner = ctx.client.as(ctx.P.OWNER);
  const base = { projectId: project.id };
  const bytes = new TextEncoder().encode('eager upload before session readiness\n'.repeat(4000));
  let attachmentId = '';
  const begin = '/v1/projects/:projectId/attachments';
  const chunk = '/v1/projects/:projectId/attachments/:attachmentId/chunks/:index';
  const complete = '/v1/projects/:projectId/attachments/:attachmentId/complete';
  const remove = '/v1/projects/:projectId/attachments/:attachmentId';
  await ctx.step('anonymous upload initiation is refused and empty or oversized declarations create no upload', async () => {
    (await ctx.client.as(ctx.P.ANON).post(begin, { filename: 'probe.txt', mime: 'text/plain', size: bytes.length }, { params: base })).status(401);
    for (const size of [0, 50 * 1024 * 1024 + 1]) {
      (await owner.post(begin, { filename: 'probe.txt', mime: 'text/plain', size }, { params: base })).status(413);
    }
  });
  await ctx.step('start a project upload before creating any session and receive an opaque handle', async () => {
    const result = await owner.post(begin, { filename: 'eager.txt', mime: 'text/plain', size: bytes.length }, { params: base });
    result.status(201);
    const data = result.json<any>();
    attachmentId = data.attachment_id;
    if (data.chunk_size !== 65536 || data.size !== bytes.length || data.object_path || data.url) throw new Error('Invalid upload handle metadata');
  });
  const params = () => ({ ...base, attachmentId });
  await ctx.step('incomplete finalization returns409 and oversized actual chunk returns413', async () => {
    (await owner.post(complete, {}, { params: params() })).status(409);
    (await owner.put(chunk, new Uint8Array(65537), { params: { ...params(), index: 0 }, raw: true, headers: { 'Content-Type': 'application/octet-stream' } })).status(413);
  });
  await ctx.step('upload more than128KiB in64KiB requests and replay one acknowledged chunk without duplicating bytes', async () => {
    for (let offset = 0, index = 0; offset < bytes.length; offset += 65536, index++) {
      const body = bytes.subarray(offset, offset + 65536);
      const options = { params: { ...params(), index }, raw: true, headers: { 'Content-Type': 'application/octet-stream' } };
      const result = await owner.put(chunk, body, options);
      result.status(200).body().has('$.received_bytes', Math.min(offset + 65536, bytes.length));
      if (index === 0) (await owner.put(chunk, body, options)).status(200).body().has('$.received_bytes', 65536);
    }
    (await owner.post(complete, {}, { params: params() })).status(200).body().has('$.filename', 'eager.txt');
    (await owner.post(complete, {}, { params: params() })).status(200).body().has('$.attachment_id', attachmentId);
  });
  const sessionId = await createDatabaseSession(ctx.env, { projectId: project.id, accountId: ctx.P.OWNER.accountId!, userId: ctx.P.OWNER.userId!, metadata: { warm: true } });
  ctx.track('session', sessionId, { projectId: project.id });
  const warmBody = { session_id: sessionId, pending_prompt: { text: 'SESS-28 eager attachment', attachment_names: ['eager.txt'], parts: [{ type: 'text', text: 'SESS-28 eager attachment' }, { type: 'file', attachment_id: attachmentId, filename: 'untrusted.txt', mime: 'image/png' }] } };
  await ctx.step('claim a warm session with the ready handle and read canonical filename from the durable inbox', async () => {
    (await owner.post('/v1/projects/:projectId/sessions/warm/claim', warmBody, { params: base })).status(200);
    (await owner.post('/v1/projects/:projectId/sessions/warm/claim', warmBody, { params: base })).status(200);
    (await owner.post('/v1/projects/:projectId/sessions/warm/claim', { ...warmBody, pending_prompt: { ...warmBody.pending_prompt, text: 'different submission' } }, { params: base })).status(409);
    const inbox = await owner.get('/v1/projects/:projectId/sessions/:sessionId/prompts', { params: { ...base, sessionId } });
    inbox.status(200);
    const serialized = JSON.stringify(inbox.json());
    if (!serialized.includes('eager.txt') || serialized.includes('untrusted.txt') || serialized.includes('data:')) throw new Error('Inbox did not use canonical handle metadata');
    (await owner.del(remove, { params: params() })).status(409);
  });
  await ctx.step('enqueue a follow-up using the same handle and deduplicate the repeated client message', async () => {
    const body = { client_message_id: 'SESS-28-followup', message_id: 'msg_0198f3a1b2c4AbCdEfGhIjKlMn', parts: [{ type: 'text', text: 'SESS-28 follow-up' }, { type: 'file', attachment_id: attachmentId }] };
    const target = '/v1/projects/:projectId/sessions/:sessionId/prompts';
    const options = { params: { ...base, sessionId } };
    const first = await owner.post(target, body, options); first.status(202);
    const second = await owner.post(target, body, options); second.status(200).body().has('$.deduped', true).has('$.prompt_id', first.json<any>().prompt_id);
    const duplicate = { ...body, client_message_id: 'SESS-28-duplicate', parts: [body.parts[1], body.parts[1]] };
    (await owner.post(target, duplicate, options)).status(400);
    const missing = { ...body, client_message_id: 'SESS-28-missing', parts: [{ type: 'file', attachment_id: crypto.randomUUID() }] };
    (await owner.post(target, missing, options)).status(404);

    const token = await owner.post('/v1/projects/:projectId/cli-token', { name: 'SESS-28 descriptor' }, { params: base });
    token.status(201);
    const tokenBody = token.json<any>();
    const descriptorPath = '/v1/projects/:projectId/runtime/prompt-attachments/:attachmentId';
    const descriptorOptions = {
      params: { ...base, attachmentId },
      query: { command_id: first.json<any>().prompt_id, part_index: 1 },
    };
    (await owner.get(descriptorPath, descriptorOptions)).status(403);
    (await ctx.client.withBearer(tokenBody.secret_key, 'plain project PAT').get(descriptorPath, descriptorOptions)).status(403);

    await bindDatabaseSessionCredential(ctx.env, {
      tokenId: tokenBody.token_id,
      commandId: first.json<any>().prompt_id,
      sessionId,
      accountId: ctx.P.OWNER.accountId!,
      projectId: project.id,
    });
    const descriptor = await ctx.client.withBearer(tokenBody.secret_key, 'session PAT').get(descriptorPath, descriptorOptions);
    descriptor.status(200);
    const descriptorBody = descriptor.json<any>();
    if (
      descriptorBody.command_id !== first.json<any>().prompt_id ||
      descriptorBody.attachment_id !== attachmentId ||
      descriptorBody.part_index !== 1 ||
      descriptorBody.filename !== 'eager.txt' ||
      descriptorBody.mime !== 'text/plain' ||
      descriptorBody.size_bytes !== bytes.length ||
      !String(descriptorBody.target_path).endsWith(`/1-eager.txt`) ||
      !String(descriptorBody.download_url).startsWith('http') ||
      !/^[0-9a-f]{64}$/.test(descriptorBody.sha256)
    ) throw new Error('Descriptor did not return canonical, verified command metadata');
    (await ctx.client.withBearer(tokenBody.secret_key, 'session PAT').get(descriptorPath, {
      ...descriptorOptions,
      query: { command_id: first.json<any>().prompt_id, part_index: 0 },
    })).status(404);
    (await owner.del('/v1/projects/:projectId/cli-token/:tokenId', {
      params: { ...base, tokenId: tokenBody.token_id },
    })).status(200);
  });
  await ctx.step('remove an unfinished upload twice and keep it unavailable', async () => {
    const created = await owner.post(begin, { filename: 'removed.txt', mime: 'text/plain', size: 1 }, { params: base }); created.status(201);
    const unused = { ...base, attachmentId: created.json<any>().attachment_id };
    (await owner.del(remove, { params: unused })).status(204);
    (await owner.del(remove, { params: unused })).status(204);
    (await owner.post(complete, {}, { params: unused })).status(404);
  });
});

const attachmentNames = ['README.md', 'probe.ts', 'probe.zip', 'probe.png'];
const promptText = 'SESS-27 staged mixed attachment prompt';

const stagedParts = [
  { type: 'text', text: promptText },
  {
    type: 'file',
    mime: 'text/markdown',
    filename: 'README.md',
    url: 'data:text/markdown;base64,IyBBdHRhY2htZW50IHByb2JlCg==',
  },
  {
    type: 'file',
    mime: 'application/typescript',
    filename: 'probe.ts',
    url: 'data:application/typescript;base64,ZXhwb3J0IGNvbnN0IGF0dGFjaG1lbnRQcm9iZSA9IHRydWU7Cg==',
  },
  {
    type: 'file',
    mime: 'application/zip',
    filename: 'probe.zip',
    url: 'data:application/zip;base64,UEsDBAoAAAAAAF0lIl1/dU9UEwAAABMAAAAJABwAUkVBRE1FLm1kVVQJAAP6W5dq+luXanV4CwABBPUBAAAEFAAAACMgQXR0YWNobWVudCBwcm9iZQpQSwMECgAAAAAAXSUiXVJLTVolAAAAJQAAAAgAHABwcm9iZS50c1VUCQAD+luXavpbl2p1eAsAAQT1AQAABBQAAABleHBvcnQgY29uc3QgYXR0YWNobWVudFByb2JlID0gdHJ1ZTsKUEsBAh4DCgAAAAAAXSUiXX91T1QTAAAAEwAAAAkAGAAAAAAAAQAAAKSBAAAAAFJFQURNRS5tZFVUBQAD+luXanV4CwABBPUBAAAEFAAAAFBLAQIeAwoAAAAAAF0lIl1SS01aJQAAACUAAAAIABgAAAAAAAEAAACkgVYAAABwcm9iZS50c1VUBQAD+luXanV4CwABBPUBAAAEFAAAAFBLBQYAAAAAAgACAJ0AAAC9AAAAAAA=',
  },
  {
    type: 'file',
    mime: 'image/png',
    filename: 'probe.png',
    url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  },
];

flow(
  'SESS-27',
  {
    domain: 'sessions',
    requires: ['database'],
    timeoutMs: 300_000,
    routes: [
      'POST /v1/projects/:projectId/sessions/warm/claim',
      'GET /v1/projects/:projectId/sessions/:sessionId',
      'GET /v1/projects/:projectId/sessions/:sessionId/prompts',
    ],
  },
  async (ctx) => {
    const project = await ctx.fixtures.project();
    const owner = ctx.client.as(ctx.P.OWNER);
    const retrySessionId = await createDatabaseSession(ctx.env, {
      projectId: project.id,
      accountId: ctx.P.OWNER.accountId!,
      userId: ctx.P.OWNER.userId!,
      metadata: { warm: true },
    });
    const sessionId = await createDatabaseSession(ctx.env, {
      projectId: project.id,
      accountId: ctx.P.OWNER.accountId!,
      userId: ctx.P.OWNER.userId!,
      metadata: { warm: true },
    });
    ctx.track('session', sessionId, { projectId: project.id });
    ctx.track('session', retrySessionId, { projectId: project.id });

    await ctx.step(
      'claim an unused session with Markdown, source, ZIP, and PNG parts -> 200 before runtime readiness',
      async () => {
        const r = await owner.post(
          '/v1/projects/:projectId/sessions/warm/claim',
          {
            session_id: sessionId,
            pending_prompt: {
              text: promptText,
              parts: stagedParts,
              attachment_names: attachmentNames,
            },
          },
          { params: { projectId: project.id } },
        );
        r.status(200);
        const returnedId = r.json<any>()?.session_id;
        if (returnedId !== sessionId) {
          throw new Error(
            `warm claim returned ${String(returnedId)} instead of ${sessionId}`,
          );
        }
      },
    );

    await ctx.step(
      'read the new session -> the ordered attachment names persist without duplicating prompt bytes in metadata',
      async () => {
        const r = await owner.get(
          '/v1/projects/:projectId/sessions/:sessionId',
          {
            params: { projectId: project.id, sessionId },
          },
        );
        r.status(200);
        const pending = r.json<any>()?.metadata?.pending_prompt;
        if (
          JSON.stringify(pending?.attachment_names) !==
          JSON.stringify(attachmentNames)
        ) {
          throw new Error(
            `pending attachment order changed: ${JSON.stringify(pending?.attachment_names)}`,
          );
        }
        if (
          Object.hasOwn(pending ?? {}, 'text') ||
          Object.hasOwn(pending ?? {}, 'parts')
        ) {
          throw new Error(
            'session metadata duplicated the durable prompt body',
          );
        }
      },
    );

    await ctx.step(
      'read the prompt inbox -> the pending-first row carries the accepted text and a live lifecycle state',
      async () => {
        const r = await owner.get(
          '/v1/projects/:projectId/sessions/:sessionId/prompts',
          {
            params: { projectId: project.id, sessionId },
          },
        );
        r.status(200);
        const prompt = (r.json<any>()?.prompts ?? []).find(
          (row: any) => row.client_message_id === `pending:${sessionId}`,
        );
        if (!prompt)
          throw new Error(
            'the pending-first prompt was not readable from the inbox',
          );
        if (prompt.text !== promptText) {
          throw new Error(
            `the pending-first prompt text changed: ${String(prompt.text)}`,
          );
        }
        if (
          !['queued', 'delivering', 'waiting', 'failed'].includes(prompt.state)
        ) {
          throw new Error(
            `the pending-first prompt has an invalid state: ${String(prompt.state)}`,
          );
        }
        if (
          typeof prompt.prompt_id !== 'string' ||
          prompt.prompt_id.length === 0
        ) {
          throw new Error('the pending-first prompt has no durable prompt_id');
        }
      },
    );

    await ctx.step(
      'claim with a remote ZIP -> 400, no partial prompt, and the unused session stays retryable',
      async () => {
        const rejected = await owner.post(
          '/v1/projects/:projectId/sessions/warm/claim',
          {
            session_id: retrySessionId,
            pending_prompt: {
              text: 'SESS-27 rejected remote ZIP',
              parts: [
                { type: 'text', text: 'SESS-27 rejected remote ZIP' },
                {
                  type: 'file',
                  mime: 'application/zip',
                  filename: 'remote.zip',
                  url: 'https://files.example.test/remote.zip',
                },
              ],
              attachment_names: ['remote.zip'],
            },
          },
          { params: { projectId: project.id } },
        );
        rejected
          .status(400)
          .body()
          .matches('$.error', /must be uploaded before it can be sent/);

        const session = await owner.get(
          '/v1/projects/:projectId/sessions/:sessionId',
          {
            params: { projectId: project.id, sessionId: retrySessionId },
          },
        );
        session.status(200);
        const metadata = session.json<any>()?.metadata ?? {};
        if (metadata.warm !== true || metadata.pending_prompt !== undefined) {
          throw new Error(
            `failed claim changed the unused session: ${JSON.stringify(metadata)}`,
          );
        }

        const prompts = await owner.get(
          '/v1/projects/:projectId/sessions/:sessionId/prompts',
          {
            params: { projectId: project.id, sessionId: retrySessionId },
          },
        );
        prompts.status(200);
        if ((prompts.json<any>()?.prompts ?? []).length !== 0) {
          throw new Error('a rejected remote ZIP created a partial prompt');
        }

        const retry = await owner.post(
          '/v1/projects/:projectId/sessions/warm/claim',
          {
            session_id: retrySessionId,
            pending_prompt: {
              text: 'SESS-27 valid retry',
              parts: [{ type: 'text', text: 'SESS-27 valid retry' }],
              attachment_names: [],
            },
          },
          { params: { projectId: project.id } },
        );
        retry.status(200).body().has('$.session_id', retrySessionId);
      },
    );
  },
);
