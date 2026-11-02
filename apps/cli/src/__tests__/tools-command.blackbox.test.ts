import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import KORTIX_TOOL_SOURCES from '../kortix-tools.generated.json' with { type: 'json' };

/**
 * `kortix.yaml` `tools:` through the real `kortix` process: `validate`,
 * `tools ls` and `tools eject`, as a user or an agent in a session runs them.
 * Every Kortix tool is always registered; `tools:` maps a name to a module.
 */
const cli = join(import.meta.dir, '../index.ts');
const dirs: string[] = [];
// One CLI process per call; under `--parallel=4` a cold start can take seconds.
const SPAWN_TEST_MS = 60_000;

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A project checkout: path → content. */
function project(files: Record<string, string>): string {
  const cwd = mkdtempSync(join(tmpdir(), 'kortix-tools-'));
  dirs.push(cwd);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), content);
  }
  return cwd;
}

function kortix(cwd: string, ...args: string[]) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    NO_COLOR: '1',
    KORTIX_DISABLE_SANDBOX_ENV_FILE: '1',
    KORTIX_NO_UPDATE_CHECK: '1',
    KORTIX_CONFIG_FILE: join(cwd, '.kortix-test-config.json'),
  };
  delete env.KORTIX_TOKEN;
  const result = Bun.spawnSync([process.execPath, cli, ...args], { cwd, env, timeout: 30_000 });
  const plain = (bytes: Buffer) => bytes.toString().replace(/\x1b\[[0-9;]*m/g, '');
  return { code: result.exitCode, stdout: plain(result.stdout), stderr: plain(result.stderr) };
}

const read = (cwd: string, path: string) => readFileSync(join(cwd, path), 'utf8');
const issues = (cwd: string) => JSON.parse(kortix(cwd, 'validate', '--json').stdout).issues as Array<{ path: string; message: string; severity: string }>;

const HEAD = 'default_agent: kortix\nagents:\n  kortix:\n    mode: primary\n    tools: all\n';
/** A tools map with its comments. */
const TOOLS = `# ─── Tools ───
tools:
  lookup_order: tools/lookup_order.ts   # your own tool: a module in your repo
  show: tools/show.ts               # replaces the Kortix show tool

# ─── Triggers ───
`;
const LOOKUP = "export default { description: 'Look up an order.', parameters: { type: 'object', properties: {} }, execute: () => 'ok' }\n";
const FILES = { 'tools/lookup_order.ts': LOOKUP, 'tools/show.ts': LOOKUP };

describe('kortix validate — tools', () => {
  test('a module that exists validates; a kortix:<name> value is an error at its line', () => {
    const ok = project({ 'kortix.yaml': HEAD + TOOLS, ...FILES });
    const valid = kortix(ok, 'validate');
    expect(valid.code).toBe(0);
    expect(valid.stdout).toContain('kortix.yaml is valid');

    const cwd = project({ 'kortix.yaml': `${HEAD}tools:\n  web_search: kortix:web_search\n` });
    const result = kortix(cwd, 'validate');
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('kortix.yaml:7:3  error  tools.web_search  must be a repository path to a .ts or .js module (for example tools/web_search.ts).');
    expect(result.stderr).not.toContain('does not exist in the project files');
  }, SPAWN_TEST_MS);

  test('a module that does not exist is an error', () => {
    const cwd = project({ 'kortix.yaml': HEAD + TOOLS, 'tools/show.ts': LOOKUP });
    expect(kortix(cwd, 'validate').code).toBe(1);
    expect(issues(cwd)).toEqual([
      expect.objectContaining({ path: 'tools.lookup_order', message: '"tools/lookup_order.ts" does not exist in the project files.', severity: 'error', line: 8, column: 3 }),
    ]);
  }, SPAWN_TEST_MS);
});

describe('kortix tools ls', () => {
  test('with no tools key, every Kortix tool', () => {
    const cwd = project({ 'kortix.yaml': HEAD });
    const result = kortix(cwd, 'tools', 'ls');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('NAME            KIND    SOURCE\nweb_search      kortix  kortix:web_search\nimage_search    kortix  kortix:image_search\n');
  }, SPAWN_TEST_MS);

  test('lists kind and source per tool, and reads imported files', () => {
    const cwd = project({
      'kortix.yaml': `${HEAD}imports: [team/kortix.yaml]\ntools:\n  show: tools/show.ts\n`,
      'team/kortix.yaml': 'tools:\n  lookup_order: team/tools/lookup_order.ts\n',
    });
    const text = kortix(cwd, 'tools', 'ls');
    expect(text.code).toBe(0);
    expect(text.stdout).toContain(
      [
        'NAME            KIND                 SOURCE',
        'web_search      kortix               kortix:web_search',
        'image_search    kortix               kortix:image_search',
        'image_gen       kortix               kortix:image_gen',
        'scrape_webpage  kortix               kortix:scrape_webpage',
        'show            kortix (overridden)  tools/show.ts',
        'lookup_order    project              team/tools/lookup_order.ts',
      ].join('\n'),
    );
    const json = kortix(cwd, 'tools', 'ls', '--json');
    expect(json.code).toBe(0);
    const listed = JSON.parse(json.stdout) as { manifest: string; tools: Array<{ name: string; kind: string; source: string }> };
    expect(listed.manifest).toBe(join(realpathSync(cwd), 'kortix.yaml'));
    expect(listed.tools.find((tool) => tool.name === 'show')).toEqual({ name: 'show', kind: 'kortix (overridden)', source: 'tools/show.ts' });
    expect(listed.tools.at(-1)).toEqual({ name: 'lookup_order', kind: 'project', source: 'team/tools/lookup_order.ts' });
  }, SPAWN_TEST_MS);

  test('an ejected copy of the retired memory tool lists as a project tool, and eject no longer offers it', () => {
    const cwd = project({ 'kortix.yaml': `${HEAD}tools:\n  memory: tools/memory.ts\n`, 'tools/memory.ts': LOOKUP });
    const listed = JSON.parse(kortix(cwd, 'tools', 'ls', '--json').stdout) as { tools: Array<{ name: string; kind: string; source: string }> };
    expect(listed.tools.find((tool) => tool.name === 'memory')).toEqual({ name: 'memory', kind: 'project', source: 'tools/memory.ts' });
    expect(issues(cwd).filter((issue) => issue.severity === 'error')).toEqual([]);
    const refused = kortix(cwd, 'tools', 'eject', 'memory');
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain('"memory" is not a Kortix tool.');
  }, SPAWN_TEST_MS);

  test('no manifest is exit 2', () => {
    const cwd = project({});
    expect(kortix(cwd, 'tools', 'ls').code).toBe(2);
  }, SPAWN_TEST_MS);
});

describe('kortix tools eject', () => {
  test('writes the Kortix source and adds only the module entry; every comment stays; the result validates', () => {
    const cwd = project({ 'kortix.yaml': HEAD + TOOLS, ...FILES });
    const result = kortix(cwd, 'tools', 'eject', 'web_search');
    expect(result.code).toBe(0);
    expect(read(cwd, 'tools/web_search.ts')).toBe((KORTIX_TOOL_SOURCES as Record<string, string>).web_search!);
    expect(read(cwd, 'kortix.yaml')).toBe(
      HEAD + TOOLS.replace('# replaces the Kortix show tool\n', '# replaces the Kortix show tool\n  web_search: tools/web_search.ts  # ejected from kortix:web_search\n'),
    );
    expect(result.stdout).toContain('Ejected web_search');
    expect(result.stdout).toContain('2. kortix validate');
    expect(result.stdout).toContain('kortix cr open');
    expect(issues(cwd)).toEqual([]);
    expect(JSON.parse(kortix(cwd, 'tools', 'ls', '--json').stdout).tools[0]).toEqual({ name: 'web_search', kind: 'kortix (overridden)', source: 'tools/web_search.ts' });
  }, SPAWN_TEST_MS);

  test('drops kortix_version from the manifest it rewrites', () => {
    const cwd = project({ 'kortix.yaml': `kortix_version: 3\n${HEAD}` });
    expect(kortix(cwd, 'tools', 'eject', 'show').code).toBe(0);
    expect(read(cwd, 'kortix.yaml')).toBe(`${HEAD}\ntools:\n  show: tools/show.ts  # ejected from kortix:show\n`);
  }, SPAWN_TEST_MS);

  test('an entry declared in an imported file is edited in that file', () => {
    const cwd = project({ 'kortix.yaml': `${HEAD}imports: [team.yaml]\n`, 'team.yaml': 'tools:\n  show: team/show.ts  # team show\n', 'team/show.ts': LOOKUP });
    expect(kortix(cwd, 'tools', 'eject', 'show', '--force').code).toBe(0);
    expect(read(cwd, 'team.yaml')).toBe('tools:\n  show: tools/show.ts  # ejected from kortix:show\n');
    expect(read(cwd, 'kortix.yaml')).toBe(`${HEAD}imports: [team.yaml]\n`);
    expect(issues(cwd).filter((issue) => issue.severity === 'error')).toEqual([]);
  }, SPAWN_TEST_MS);

  test('refuses an existing file without --force, and a name that is not a Kortix tool', () => {
    const cwd = project({ 'kortix.yaml': HEAD, 'tools/show.ts': 'mine\n' });
    const refused = kortix(cwd, 'tools', 'eject', 'show');
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('tools/show.ts exists.');
    expect(read(cwd, 'tools/show.ts')).toBe('mine\n');
    expect(read(cwd, 'kortix.yaml')).toBe(HEAD);

    expect(kortix(cwd, 'tools', 'eject', 'show', '--force').code).toBe(0);
    expect(read(cwd, 'tools/show.ts')).toBe((KORTIX_TOOL_SOURCES as Record<string, string>).show!);

    const unknown = kortix(cwd, 'tools', 'eject', 'lookup_order');
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain('"lookup_order" is not a Kortix tool.');
    expect(unknown.stderr).toContain('Eject one of: web_search, image_search, image_gen, scrape_webpage, show.');
    expect(existsSync(join(cwd, 'tools/lookup_order.ts'))).toBe(false);
  }, SPAWN_TEST_MS);
});
