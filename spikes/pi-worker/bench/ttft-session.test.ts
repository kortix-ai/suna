import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
describe('product-protocol benchmark process', () => {
  test.each([
    { workerPath: 'new-session', runtime: 'pi' },
    { workerPath: 'resume', runtime: 'pi' },
    { workerPath: 'new-session', runtime: 'opencode' },
    { workerPath: 'resume', runtime: 'pi', invalid: 'active' },
    { workerPath: 'resume', runtime: 'pi', invalid: 'configuration' },
    { workerPath: 'new-session', runtime: 'pi', invalid: 'runtime' },
    { workerPath: 'new-session', runtime: 'pi', invalid: 'model' },
    { workerPath: 'new-session', runtime: 'pi', invalid: 'mixed-model' },
    { workerPath: 'new-session', runtime: 'pi', invalid: 'start-failed' },
  ])('measures the declared lifecycle and rejects invalid evidence: %j', async ({ workerPath, runtime, invalid }) => {
    const encoder = new TextEncoder();
    const calls: string[] = [];
    let status = workerPath === 'resume' && invalid !== 'active' ? 'stopped' : 'running';
    let createdBody: unknown;
    let starts = 0;
    let eventController: ReadableStreamDefaultController<Uint8Array> | null = null;
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        calls.push(`${request.method} ${url.pathname}`);
        const origin = `http://127.0.0.1:${server.port}`;
        if (request.method === 'GET' && url.pathname === '/v1/health') {
          return Response.json({
            status: 'ok',
            environment: 'test',
            version: 'test',
            commit: 'abc123',
            started_at: '2026-09-04T00:00:00.000Z',
            instance: 'bench-test',
          });
        }
        if (request.method === 'POST' && url.pathname === '/v1/projects/project-1/sessions') {
          createdBody = await request.json();
          return Response.json({
            session_id: 'session-1',
            agent_name: invalid === 'configuration' ? 'another-agent' : 'reviewer',
            base_ref: 'fixture-sha',
            sandbox_url: `${origin}/runtime`,
            sandbox_provider: 'daytona',
            status,
            opencode_session_id: 'ses_root',
            metadata: { session_start_timeline: { totalMs: 3 } },
          });
        }
        if (
          request.method === 'GET' &&
          url.pathname === '/v1/projects/project-1/sessions/session-1'
        ) {
          return Response.json({
            session_id: 'session-1',
            agent_name: invalid === 'configuration' ? 'another-agent' : 'reviewer',
            base_ref: 'fixture-sha',
            sandbox_url: `${origin}/runtime`,
            sandbox_provider: 'daytona',
            status,
            opencode_session_id: 'ses_root',
            metadata: { session_start_timeline: { totalMs: 3 } },
          });
        }
        if (
          request.method === 'POST' &&
          url.pathname === '/v1/projects/project-1/sessions/session-1/stop'
        ) {
          if (status === 'stopped') return Response.json({ status }, { status: 409 });
          status = 'stopped';
          return Response.json({ ok: true });
        }
        if (request.method === 'POST' && url.pathname === '/v1/projects/project-1/sessions/session-1/start') {
          if (invalid === 'start-failed') {
            status = 'stopped';
            return Response.json({ stage: 'failed', reason: 'provider_denied', failure: { message: 'Provider rejected the start' } });
          }
          status = 'running';
          starts++;
          return Response.json({ stage: 'ready', opencode_session_id: 'ses_root' });
        }
        if (request.method === 'GET' && url.pathname === '/runtime/kortix/health') {
          return Response.json({
            runtimeReady: true,
            ...(invalid === 'runtime' ? {} : runtime === 'pi' ? { engine: 'pi' } : { opencode: 'ok' }),
            commit_sha: 'def456',
            branch: 'pi-worker',
            opencode_session_id: 'ses_root',
          });
        }
        if (request.method === 'GET' && url.pathname === '/runtime/session') {
          return Response.json([{ id: 'ses_root' }]);
        }
        if (request.method === 'GET' && url.pathname === '/runtime/global/event') {
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              eventController = controller;
              controller.enqueue(encoder.encode(': connected\n\n'));
            },
            cancel() {
              eventController = null;
            },
          });
          return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
        }
        if (request.method === 'POST' && url.pathname === '/runtime/session/ses_root/message') {
          const body = (await request.json()) as { messageID: string };
          const frames = [
            {
              directory: '/workspace',
              payload: {
                id: 'evt_1',
                type: 'message.part.updated',
                properties: {
                  sessionID: 'ses_root',
                  part: {
                    sessionID: 'ses_root',
                    messageID: body.messageID,
                    type: 'text',
                    text: 'echoed user prompt',
                  },
                },
              },
            },
            {
              directory: '/workspace',
              payload: {
                id: 'evt_2',
                type: 'message.updated',
                properties: {
                  info: {
                    id: 'msg_assistant',
                    sessionID: 'ses_root',
                    role: 'assistant',
                    parentID: body.messageID,
                    providerID: 'kortix',
                    modelID: invalid === 'model' ? 'another-model' : 'anthropic/test-model',
                  },
                },
              },
            },
            {
              directory: '/workspace',
              payload: {
                id: 'evt_3',
                type: 'message.part.delta',
                properties: {
                  sessionID: 'ses_root',
                  messageID: 'msg_assistant',
                  partID: 'prt_1',
                  field: 'text',
                  delta: 'READY',
                },
              },
            },
          ];
          eventController?.enqueue(
            encoder.encode(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('')),
          );
          return Response.json({
            info: {
              id: 'msg_assistant',
              sessionID: 'ses_root',
              role: 'assistant',
              parentID: body.messageID,
              providerID: 'kortix',
              modelID: invalid === 'model' || invalid === 'mixed-model' ? 'another-model' : 'anthropic/test-model',
            },
            parts: [{ type: 'text', text: 'READY' }],
          });
        }
        return new Response('not found', { status: 404 });
      },
    });
    const directory = await mkdtemp(join(tmpdir(), 'kortix-ttft-bench-'));
    const output = join(directory, 'result.json');

    try {
      const child = Bun.spawn(
        [
          process.execPath,
          join(import.meta.dir, 'ttft-session.ts'),
          '--base',
          `http://127.0.0.1:${server.port}/v1`,
          '--project',
          'project-1',
          '--runtime',
          runtime,
          '--provider',
          'daytona',
          '--region',
          'test-region',
          '--model',
          'anthropic/test-model',
          '--worker-path',
          workerPath,
          '--agent', 'reviewer',
          '--base-ref', 'fixture-sha',
          ...(workerPath === 'resume' ? ['--session', 'session-1'] : []),
          '--workspace-path',
          'not-observed',
          '--runs',
          '1',
          '--output',
          output,
        ],
        {
          env: { ...process.env, KORTIX_BENCH_JWT: 'test-jwt' },
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(stderr).toBe('');
      if (invalid) {
        expect(exitCode).toBe(1);
        expect(stdout).toContain('usable 0; failed 1; cleanup failures 0');
        const failure = await Bun.file(output).json();
        const errors: Record<string, string> = {
          active: 'resume requires stopped',
          configuration: 'resume configuration does not match',
          runtime: 'runtime mismatch',
          model: 'model mismatch',
          'mixed-model': 'model mismatch',
          'start-failed': 'provider_denied; Provider rejected the start',
        };
        expect(failure.results[0].error).toContain(errors[invalid]!);
        if (invalid === 'active' || invalid === 'configuration') {
          expect(starts).toBe(0);
          expect(calls.some((call) => call.endsWith('/stop'))).toBe(false);
          expect(calls.some((call) => call.endsWith('/message'))).toBe(false);
        } else {
          expect(status).toBe('stopped');
          if (invalid === 'start-failed') expect(failure.results[0].cleanup).toMatchObject({ status: 409, alreadyStopped: true });
        }
        return;
      }
      expect(exitCode).toBe(0);
      expect(stdout).toContain('usable 1; failed 0; cleanup failures 0');
      const result = (await Bun.file(output).json()) as {
        protocol: { events: string; message: string };
        summary: { usable: number };
        results: Array<{
          firstTokenMs?: number;
          provider?: string;
          observedModels?: string[];
          cleanup?: { status?: number };
        }>;
      };
      expect(result.protocol).toMatchObject({
        events: 'GET /global/event',
        message: 'POST /session/:sessionId/message',
      });
      expect(result.summary.usable).toBe(1);
      expect(result.results[0]).toMatchObject({
        firstTokenMs: expect.any(Number),
        provider: 'daytona',
        observedModels: ['kortix/anthropic/test-model'],
        cleanup: { status: 200 },
      });
      expect(starts).toBe(1);
      expect(status).toBe('stopped');
      if (workerPath === 'resume') expect(createdBody).toBeUndefined();
      else expect(createdBody).toEqual({ agent_name: 'reviewer', base_ref: 'fixture-sha', opencode_model: 'anthropic/test-model', provider: 'daytona' });
      expect(calls).toContain('GET /runtime/global/event');
      expect(calls).toContain('POST /runtime/session/ses_root/message');
      expect(calls).toContain('POST /v1/projects/project-1/sessions/session-1/stop');
      expect(calls.some((call) => call.includes('/turn'))).toBe(false);
    } finally {
      server.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  }, 10_000);
});
