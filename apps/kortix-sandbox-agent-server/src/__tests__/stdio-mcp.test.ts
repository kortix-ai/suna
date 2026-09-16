import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceHistory } from '../workspace-history';
import { StdioMcpPool } from '../stdio-mcp';
const fixtures: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of fixtures.splice(0)) await close();
});
async function fixture(
  options: {
    idleTimeoutMs?: number;
    historyLock?: string;
    environment?: () => NodeJS.ProcessEnv;
  } = {},
) {
  const cwd = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'pi-stdio-')),
  );
  const pool = new StdioMcpPool({
    cwd,
    environment: () => ({
      ...process.env,
      FIXTURE_SECRET: 'injected-value',
      KORTIX_TOKEN: 'must-not-inherit',
    }),
    ...options,
  });
  fixtures.push(async () => {
    await pool.closeAll();
    await fs.rm(cwd, { recursive: true, force: true });
  });
  const configuration = {
    type: 'local' as const,
    command: [
      process.execPath,
      path.join(import.meta.dir, 'fixtures/stdio-mcp-server.mjs'),
    ],
    environment: { FIXTURE_VALUE: '{env:FIXTURE_SECRET}' },
  };
  const discover = () =>
    pool.request({ server: 'fixture', configuration, method: 'tools/list' });
  return { pool, cwd, configuration, discover };
}
test('stdio discovery is lazy and calls preserve process state, arguments, cwd, and scoped environment', async () => {
  const f = await fixture();
  expect(f.pool.active).toBe(0);
  const first = await f.discover();
  expect(first.result).toMatchObject({
    nextCursor: 'page2',
    tools: [{ name: 'counter' }],
  });
  const call = () =>
    f.pool.request({
      server: 'fixture',
      configuration: f.configuration,
      connectionId: first.connectionId,
      method: 'tools/call',
      params: { name: 'counter', arguments: { exact: 'a b;$(false)' } },
    });
  const a = JSON.parse((await call()).result.content[0].text);
  const b = JSON.parse((await call()).result.content[0].text);
  expect(a).toMatchObject({
    count: 1,
    cwd: f.cwd,
    environment: 'injected-value',
    privateToken: null,
    arguments: { exact: 'a b;$(false)' },
  });
  expect(b).toMatchObject({ count: 2, pid: a.pid });
  expect(f.pool.active).toBe(1);
  await f.pool.disconnect('fixture', first.connectionId);
  expect(f.pool.active).toBe(0);
});
test('expired connections fail before execution until explicitly rediscovered', async () => {
  const f = await fixture();
  const first = await f.discover();
  await f.pool.disconnect('fixture', first.connectionId);
  await expect(
    f.pool.request({
      server: 'fixture',
      configuration: f.configuration,
      connectionId: first.connectionId,
      method: 'tools/call',
      params: { name: 'counter' },
    }),
  ).rejects.toThrow(/connection/);
  expect(f.pool.active).toBe(0);
  const next = await f.discover();
  expect(next.connectionId).not.toBe(first.connectionId);
});
test('stdio covers paged tools, resources, templates, and prompts', async () => {
  const f = await fixture();
  const first = await f.discover();
  for (const [method, params, field] of [
    ['tools/list', { cursor: 'page2' }, 'tools'],
    ['resources/list', {}, 'resources'],
    ['resources/templates/list', {}, 'resourceTemplates'],
    ['resources/read', { uri: 'fixture://value' }, 'contents'],
    ['prompts/list', {}, 'prompts'],
    ['prompts/get', { name: 'review' }, 'messages'],
  ] as const) {
    expect(
      (
        await f.pool.request({
          server: 'fixture',
          configuration: f.configuration,
          connectionId: first.connectionId,
          method,
          params,
        })
      ).result[field],
    ).toHaveLength(1);
  }
});
test.each(['invalid', 'oversize', 'crash', 'schema', 'rpc_error'])(
  'malformed or lost stdio response closes the process without replay: %s',
  async (name) => {
    const f = await fixture();
    const first = await f.discover();
    await expect(
      f.pool.request({
        server: 'fixture',
        configuration: f.configuration,
        connectionId: first.connectionId,
        method: 'tools/call',
        params: { name },
      }),
    ).rejects.toThrow();
    expect(f.pool.active).toBe(0);
  },
);
test('Stop closes an active server before returning and the next discovery creates a clean connection', async () => {
  const f = await fixture();
  const first = await f.discover();
  const controller = new AbortController();
  const run = f.pool.request(
    {
      server: 'fixture',
      configuration: f.configuration,
      connectionId: first.connectionId,
      method: 'tools/call',
      params: { name: 'sleep' },
    },
    controller.signal,
  );
  void run.catch(() => {});
  for (
    let i = 0;
    i < 200 && !(await fs.exists(path.join(f.cwd, 'started')));
    i++
  )
    await Bun.sleep(5);
  expect(await fs.exists(path.join(f.cwd, 'started'))).toBe(true);
  controller.abort();
  await expect(run).rejects.toThrow();
  expect(f.pool.active).toBe(0);
  expect(await fs.exists(path.join(f.cwd, 'late'))).toBe(false);
  expect((await f.discover()).connectionId).not.toBe(first.connectionId);
});
test('missing environment references and disabled or malformed configurations never start a process', async () => {
  const f = await fixture();
  for (const configuration of [
    { ...f.configuration, enabled: false },
    { ...f.configuration, environment: { TOKEN: '{env:DOES_NOT_EXIST}' } },
    { ...f.configuration, type: 'remote' },
  ]) {
    await expect(
      f.pool.request({
        server: 'fixture',
        configuration: configuration as any,
        method: 'tools/list',
      }),
    ).rejects.toThrow();
    expect(f.pool.active).toBe(0);
  }
});

async function until(check: () => Promise<boolean> | boolean, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('Condition timed out');
    await Bun.sleep(10);
  }
}
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('idle expiry and configuration rotation require explicit rediscovery', async () => {
  const source = { TOKEN: 'first' };
  const f = await fixture({ idleTimeoutMs: 50, environment: () => source });
  f.configuration.environment = { FIXTURE_VALUE: '{env:TOKEN}' };
  const first = await f.discover();
  source.TOKEN = 'second';
  await expect(
    f.pool.request({
      server: 'fixture',
      configuration: f.configuration,
      method: 'tools/call',
      connectionId: first.connectionId,
      params: { name: 'counter' },
    }),
  ).rejects.toThrow(/connection/);
  const second = await f.discover();
  expect(second.connectionId).not.toBe(first.connectionId);
  const result = await f.pool.request({
    server: 'fixture',
    configuration: f.configuration,
    method: 'tools/call',
    connectionId: second.connectionId,
    params: { name: 'counter' },
  });
  expect(JSON.parse(result.result.content[0].text)).toMatchObject({
    environment: 'second',
    count: 1,
  });
  await until(() => f.pool.active === 0);
  await expect(
    f.pool.request({
      server: 'fixture',
      configuration: f.configuration,
      method: 'tools/call',
      connectionId: second.connectionId,
    }),
  ).rejects.toThrow(/connection/);
});

test('one server rejects concurrent calls while another server remains available; timeout stops the writer', async () => {
  const f = await fixture();
  const first = await f.discover();
  const configuration = { ...f.configuration, timeout: 250 };
  const pending = f.pool.request({
    server: 'fixture',
    configuration,
    connectionId: first.connectionId,
    method: 'tools/call',
    params: { name: 'sleep' },
  });
  void pending.catch(() => {});
  await until(() => fs.exists(path.join(f.cwd, 'started')));
  await expect(f.discover()).rejects.toThrow(/active request/);
  await expect(
    f.pool.disconnect('fixture', first.connectionId),
  ).rejects.toThrow(/active request/);
  const other = await f.pool.request({
    server: 'other',
    configuration: f.configuration,
    method: 'tools/list',
  });
  expect(other.connectionId).not.toBe(first.connectionId);
  await expect(pending).rejects.toThrow(/timed out/);
  expect(
    alive(Number(await fs.readFile(path.join(f.cwd, 'started'), 'utf8'))),
  ).toBe(false);
  expect(await fs.exists(path.join(f.cwd, 'late'))).toBe(false);
});

test('missing executable and pre-aborted requests leave no process', async () => {
  const f = await fixture();
  await expect(
    f.pool.request({
      server: 'fixture',
      configuration: { ...f.configuration, command: ['/does/not/exist'] },
      method: 'tools/list',
    }),
  ).rejects.toThrow();
  expect(f.pool.active).toBe(0);
  await expect(
    f.pool.request(
      {
        server: 'fixture',
        configuration: f.configuration,
        method: 'tools/list',
      },
      AbortSignal.abort(),
    ),
  ).rejects.toThrow();
  expect(f.pool.active).toBe(0);
});

test.each([false, true])(
  'MCP holds a cross-process rewind lock before and after history initialization (%s)',
  async (initialized) => {
    const f = await fixture();
    const state = path.join(f.cwd, 'history');
    const workspace = path.join(f.cwd, 'work');
    await fs.mkdir(workspace);
    const history = new WorkspaceHistory({
      workspace,
      state,
      scope: 'fixture',
    });
    if (initialized) await history.capture(crypto.randomUUID());
    const parent = Bun.spawn(
      [
        process.execPath,
        path.join(import.meta.dir, 'fixtures/stdio-mcp-parent.ts'),
        workspace,
        path.join(state, 'lock.sqlite'),
      ],
      { stdout: 'ignore', stderr: 'pipe' },
    );
    try {
      await until(() => fs.exists(path.join(workspace, 'ready.json')));
      const pids = JSON.parse(
        await fs.readFile(path.join(workspace, 'ready.json'), 'utf8'),
      );
      expect(alive(pids.pid)).toBe(true);
      expect(alive(pids.child)).toBe(true);
      await expect(history.capture(crypto.randomUUID())).rejects.toThrow(
        /busy|locked|operation/i,
      );
      parent.kill('SIGKILL');
      await parent.exited;
      await until(() => !alive(pids.pid) && !alive(pids.child));
      expect(
        (await history.capture(crypto.randomUUID())).snapshotId,
      ).toBeString();
    } finally {
      if (parent.exitCode === null) parent.kill('SIGKILL');
      await parent.exited;
    }
  },
);

test('capacity bounds processes, preserves existing connections, and accepts another after disconnect', async () => {
  const f = await fixture();
  const connections = [];
  for (let i = 0; i < 16; i++)
    connections.push(
      await f.pool.request({
        server: `server${i}`,
        configuration: f.configuration,
        method: 'tools/list',
      }),
    );
  expect(f.pool.active).toBe(16);
  await expect(
    f.pool.request({
      server: 'overflow',
      configuration: f.configuration,
      method: 'tools/list',
    }),
  ).rejects.toThrow(/16/);
  expect(f.pool.active).toBe(16);
  await f.pool.disconnect('server0', connections[0]!.connectionId);
  expect(
    (
      await f.pool.request({
        server: 'overflow',
        configuration: f.configuration,
        method: 'tools/list',
      })
    ).connectionId,
  ).toBeString();
}, 15000);

test('oversized requests fail without executing the requested tool', async () => {
  const f = await fixture();
  const first = await f.discover();
  await expect(
    f.pool.request({
      server: 'fixture',
      configuration: f.configuration,
      connectionId: first.connectionId,
      method: 'tools/call',
      params: {
        name: 'write',
        arguments: { path: 'oversized', text: 'x'.repeat(1024 * 1024) },
      },
    }),
  ).rejects.toThrow(/1 MiB/);
  expect(await fs.exists(path.join(f.cwd, 'oversized'))).toBe(false);
  expect(f.pool.active).toBe(0);
});

test('malformed RPC identities never allocate a process', async () => {
  const f = await fixture();
  for (const identity of [
    { server: undefined },
    { server: 'fixture', connectionId: 0 },
    { server: 'fixture', connectionId: '' },
    { server: 'fixture', connectionId: 'x'.repeat(101) },
  ]) {
    await expect(
      f.pool.request({
        configuration: f.configuration,
        method: 'tools/list',
        ...identity,
      } as any),
    ).rejects.toThrow(/identity/);
    expect(f.pool.active).toBe(0);
  }
});
