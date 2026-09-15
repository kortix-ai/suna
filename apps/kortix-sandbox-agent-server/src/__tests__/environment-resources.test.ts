import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installEnvironmentResources, prepareEnvironmentResources } from '../environment-resources';
import { loadConfig } from '../config';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const resource = (target: string, text = 'original', mode = 'seed') => ({
  placement: 'environment',
  source: 'assets/example',
  target,
  mode,
  size: Buffer.byteLength(text),
  content: Buffer.from(text).toString('base64'),
  sha256: createHash('sha256').update(text).digest('hex'),
});
async function fixture() {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'pi-env-resources-'));
  roots.push(root);
  const options = {
    workspace: join(root, 'workspace'),
    helpers: join(root, 'helpers'),
    state: join(root, 'state'),
    sessionId: 'session',
    projectId: 'project',
  };
  await mkdir(options.workspace);
  return options;
}

test('seed files preserve edits and intentional deletions across environment restarts', async () => {
  const options = await fixture();
  const files = [resource('/workspace/nested/template.txt'), resource('/workspace/deleted.txt')];
  await installEnvironmentResources(files, options);
  expect(await readFile(join(options.workspace, 'nested/template.txt'), 'utf8')).toBe('original');
  await writeFile(join(options.workspace, 'nested/template.txt'), 'user edited');
  await rm(join(options.workspace, 'deleted.txt'));
  await installEnvironmentResources(files, options);
  expect(await readFile(join(options.workspace, 'nested/template.txt'), 'utf8')).toBe(
    'user edited',
  );
  expect(await Bun.file(join(options.workspace, 'deleted.txt')).exists()).toBe(false);
});

test('existing files survive first seed installation and helpers receive exact read-only bytes', async () => {
  const options = await fixture();
  await writeFile(join(options.workspace, 'template.txt'), 'existing checkout');
  await installEnvironmentResources(
    [
      resource('/workspace/template.txt'),
      resource('/opt/kortix/helpers/check.py', 'print(42)', 'read_only'),
    ],
    options,
  );
  expect(await readFile(join(options.workspace, 'template.txt'), 'utf8')).toBe('existing checkout');
  expect(await readFile(join(options.helpers, 'check.py'), 'utf8')).toBe('print(42)');
  expect((await stat(join(options.helpers, 'check.py'))).mode & 0o777).toBe(0o444);
});

test.each(['parent', 'leaf'])(
  'resource installation rejects %s symlinks without changing outside files',
  async (location) => {
    const options = await fixture();
    const outside = join(options.state, 'outside');
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, 'x'), 'outside');
    await symlink(
      location === 'parent' ? outside : join(outside, 'x'),
      join(options.workspace, 'link'),
    );
    await expect(
      installEnvironmentResources(
        [resource(location === 'parent' ? '/workspace/link/x' : '/workspace/link')],
        options,
      ),
    ).rejects.toThrow(/symlink/);
    expect(await readFile(join(outside, 'x'), 'utf8')).toBe('outside');
  },
);

test('a corrupt later resource rejects the whole bundle before the first file is written', async () => {
  const options = await fixture();
  await expect(
    installEnvironmentResources(
      [resource('/workspace/a'), { ...resource('/workspace/b'), sha256: '0'.repeat(64) }],
      options,
    ),
  ).rejects.toThrow(/integrity/);
  expect(await Bun.file(join(options.workspace, 'a')).exists()).toBe(false);
});

test('worker-only resources cannot be installed in the environment', async () => {
  const options = await fixture();
  const { target, mode, ...file } = resource('/workspace/x');
  await expect(
    installEnvironmentResources([{ ...file, placement: 'worker', name: 'private' }], options),
  ).rejects.toThrow(/environment/);
});

test('resource download verifies session identity and fails startup on an HTTP error', async () => {
  const options = await fixture();
  const cfg = loadConfig({
    KORTIX_WORKSPACE: options.workspace,
    KORTIX_PROJECT_ID: 'project',
    KORTIX_API_URL: 'https://api.kortix.test/v1',
    KORTIX_TOKEN: 'test-token',
  });
  const env = {
    KORTIX_SESSION_ID: 'session',
    KORTIX_AGENT_NAME: 'agent',
    KORTIX_AGENT_STATE_DIR: options.state,
  };
  let request: { url: string; auth: string | null } | undefined;
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    request = { url: String(url), auth: new Headers(init?.headers).get('authorization') };
    return Response.json({
      project_id: 'project',
      session_id: 'other',
      agent_name: 'agent',
      source_sha: 'a'.repeat(40),
      files: [resource('/workspace/x')],
    });
  };
  await expect(prepareEnvironmentResources(cfg, env, { fetchImpl })).rejects.toThrow(/identity/);
  expect(request).toEqual({
    url: 'https://api.kortix.test/v1/projects/project/sessions/session/environment/resources',
    auth: 'Bearer test-token',
  });
  expect(await Bun.file(join(options.workspace, 'x')).exists()).toBe(false);
  await expect(
    prepareEnvironmentResources(cfg, env, {
      fetchImpl: async () => new Response('', { status: 503 }),
    }),
  ).rejects.toThrow(/503/);
});

test('aborted installation writes nothing and a successful authenticated download installs files', async () => {
  const options = await fixture();
  await expect(
    installEnvironmentResources([resource('/workspace/x')], {
      ...options,
      signal: AbortSignal.abort(),
    }),
  ).rejects.toThrow();
  expect(await Bun.file(join(options.workspace, 'x')).exists()).toBe(false);
  const cfg = loadConfig({
    KORTIX_WORKSPACE: options.workspace,
    KORTIX_PROJECT_ID: 'project',
    KORTIX_API_URL: 'https://api.kortix.test/v1',
    KORTIX_TOKEN: 'test-token',
  });
  await prepareEnvironmentResources(
    cfg,
    {
      KORTIX_SESSION_ID: 'session',
      KORTIX_AGENT_NAME: 'agent',
      KORTIX_AGENT_STATE_DIR: options.state,
    },
    {
      fetchImpl: async () =>
        Response.json({
          project_id: 'project',
          session_id: 'session',
          agent_name: 'agent',
          source_sha: 'a'.repeat(40),
          files: [resource('/workspace/x')],
        }),
    },
  );
  expect(await readFile(join(options.workspace, 'x'), 'utf8')).toBe('original');
});
