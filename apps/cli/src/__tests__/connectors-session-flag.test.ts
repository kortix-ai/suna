import { join, resolve } from 'node:path';
import { expect, test } from 'bun:test';

const CLI_ROOT = resolve(import.meta.dir, '..', '..');

for (const command of ['ls', 'list']) {
  for (const sessionFlag of [['--session', 'synthetic-session'], ['--session=synthetic-session']]) {
    test(`${command} ${sessionFlag.join(' ')} uses the gateway catalog`, async () => {
      const requests: string[] = [];
      const server = Bun.serve({
        port: 0,
        fetch(request) {
          const url = new URL(request.url);
          requests.push(url.pathname + url.search);
          return Response.json({ connectors: [{ slug: 'synthetic', provider: 'http', status: 'active', actions: [{ path: 'read' }] }] });
        },
      });
      try {
        const proc = Bun.spawn({
          cmd: [process.execPath, join(CLI_ROOT, 'src/index.ts'), 'connectors', command, ...sessionFlag],
          cwd: CLI_ROOT,
          env: {
            ...process.env,
            KORTIX_TOKEN: 'synthetic-token',
            KORTIX_API_URL: `http://127.0.0.1:${server.port}/v1`,
            KORTIX_PROJECT_ID: 'synthetic-project',
            KORTIX_NO_UPDATE_CHECK: '1',
            KORTIX_DISABLE_SANDBOX_ENV_FILE: '1',
            NO_COLOR: '1',
          },
          stdout: 'pipe',
          stderr: 'pipe',
        });
        const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
        expect(code).toBe(0);
        expect(stderr).toBe('');
        expect(JSON.parse(stdout)).toEqual({ connectors: [{ slug: 'synthetic', provider: 'http', status: 'active', tools: ['synthetic.read'] }] });
        expect(requests).toEqual(['/v1/connectors/projects/synthetic-project/catalog?include_schemas=false']);
      } finally {
        server.stop(true);
      }
    });
  }
}
