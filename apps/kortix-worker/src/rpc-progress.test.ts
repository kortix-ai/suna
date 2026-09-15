import { expect, test } from 'bun:test';
import { KortixExecutionEnv } from './kortix-env';

for (const transport of ['fetch', 'keepalive', 'ws', 'auto'] as const) {
  for (const incomplete of [false, true]) {
    test(`${transport} ${incomplete ? 'rejects an incomplete stream without replaying execution' : 'accepts a legacy daemon and delivers final output once'}`, async () => {
      let calls = 0;
      const result = { ok: true as const, value: { stdout: 'OUTPUT', stderr: 'ERROR', exitCode: 3 } };
      const progress = { stream: 'stdout', chunk: 'OUTPUT' };
      const server = Bun.serve<undefined>({
        port: 0,
        async fetch(request, server) {
          if (new URL(request.url).pathname.endsWith('/rpc-ws')) {
            if (server.upgrade(request, { data: undefined })) return;
            return new Response(null, { status: 400 });
          }
          const body = (await request.json()) as { op: string; stream: boolean };
          expect(body.op).toBe('exec');
          expect(body.stream).toBe(true);
          calls++;
          if (!incomplete) return Response.json(result);
          return new Response(JSON.stringify({ type: 'progress', progress }) + '\n', {
            headers: { 'content-type': 'application/x-ndjson' },
          });
        },
        websocket: {
          message(ws, message) {
            const body = JSON.parse(String(message));
            expect(body.op).toBe('exec');
            expect(body.stream).toBe(true);
            calls++;
            if (!incomplete) ws.send(JSON.stringify({ id: body.id, body: result }));
            else {
              ws.send(JSON.stringify({ id: body.id, type: 'progress', progress }));
              ws.close();
            }
          },
        },
      });
      const env = new KortixExecutionEnv({
        baseUrl: `http://127.0.0.1:${server.port}`,
        cwd: '/workspace',
        transport,
      });
      const stdout: string[] = [];
      const stderr: string[] = [];
      try {
        const actual = await env.exec('an execution that must not repeat', {
          onStdout: (chunk) => {
            stdout.push(chunk);
          },
          onStderr: (chunk) => {
            stderr.push(chunk);
          },
        });
        expect(calls).toBe(1);
        expect(stdout).toEqual(['OUTPUT']);
        if (incomplete) {
          expect(actual.ok).toBe(false);
          expect(stderr).toEqual([]);
        } else {
          expect(actual).toEqual(result);
          expect(stderr).toEqual(['ERROR']);
        }
      } finally {
        await env.cleanup();
        server.stop(true);
      }
    });
  }
}
