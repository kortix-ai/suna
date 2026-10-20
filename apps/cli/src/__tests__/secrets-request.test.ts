import { expect, test } from 'bun:test';
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('request --show recovers the original link without minting and isolates credentials', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'secrets-request-'));
  let minted = 0;
  const server = Bun.serve({
    port: 0,
    fetch: () => {
      minted++;
      return Response.json({
        url: 'https://example.test/secret-intake/synthetic',
        names: ['TEST_KEY'],
        scope: 'connector',
        expires_at: '2099-01-01T00:00:00Z',
      });
    },
  });
  const config = join(dir, 'config.json');
  const configure = (token: string) =>
    writeFileSync(
      config,
      JSON.stringify({
        active: 'test',
        hosts: {
          test: {
            url: `http://localhost:${server.port}`,
            token,
            user_id: 'synthetic',
            account_id: 'synthetic',
          },
        },
      }),
    );
  const run = async (...args: string[]) => {
    const env: Record<string, string | undefined> = {
      ...process.env,
      KORTIX_CONFIG_FILE: config,
      KORTIX_DISABLE_SANDBOX_ENV_FILE: '1',
      KORTIX_NO_UPDATE_CHECK: '1',
      NO_COLOR: '1',
    };
    for (const key of [
      'KORTIX_API_URL',
      'KORTIX_CLI_TOKEN',
      'KORTIX_PROJECT_ID',
      'KORTIX_TOKEN',
    ])
      delete env[key];
    const proc = Bun.spawn(
      [
        process.execPath,
        resolve(import.meta.dir, '../index.ts'),
        'secrets',
        'request',
        'TEST_KEY',
        '--project',
        'synthetic',
        '--json',
        ...args,
      ],
      { cwd: dir, env, stdout: 'pipe', stderr: 'pipe' },
    );
    return {
      code: await proc.exited,
      out: await new Response(proc.stdout).text(),
      err: await new Response(proc.stderr).text(),
    };
  };
  try {
    configure('synthetic-token');
    const original = await run();
    expect(original.code).toBe(0);
    const shown = await run('--show');
    expect(shown.code).toBe(0);
    expect(JSON.parse(shown.out)).toEqual(JSON.parse(original.out));
    expect(minted).toBe(1);
    const cache = join(
      dir,
      'secret-requests',
      readdirSync(join(dir, 'secret-requests'))[0],
    );
    expect(statSync(cache).mode & 0o777).toBe(0o600);
    expect((await run('--show', '--scope', 'runtime')).code).toBe(2);
    expect((await run('--show', '--expires', '5')).code).toBe(2);
    writeFileSync(
      cache,
      JSON.stringify({
        ...JSON.parse(readFileSync(cache, 'utf8')),
        expires_at: '2000-01-01T00:00:00Z',
      }),
    );
    expect((await run('--show')).code).toBe(2);
    expect(minted).toBe(1);
    configure('other-token');
    expect((await run('--show')).code).toBe(2);
    expect(minted).toBe(1);
  } finally {
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
});
