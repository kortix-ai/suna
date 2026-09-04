/**
 * Session attachment admission — the deterministic control-plane half of
 * SESS-27. Browser evidence owns attachment tiles, reload timestamps, and turn
 * duration. The focused API tests own runtime write-failure injection. This
 * flow proves that the public warm-session claim boundary durably accepts one
 * ordered mixed batch before runtime readiness and leaves the unused session
 * retryable when staged non-native bytes are absent.
 */
import { flow } from '../core/flow';
import { createDatabaseSession } from '../fixtures/database-project';

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
