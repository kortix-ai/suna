import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import KORTIX_TOOL_SOURCES from '../kortix-tools.generated.json' with { type: 'json' };

/**
 * `kortix.yaml` `tools:` with Kortix tools as `kortix:<name>`, through the real
 * `kortix` process: `validate`, `tools ls` and `tools eject`, as a user or an
 * agent in a session runs them.
 */
const cli = join(import.meta.dir, '../index.ts');
const dirs: string[] = [];
// One CLI process per call; under `--parallel=4` a cold start can take seconds.
const SPAWN_TEST_MS = 60_000;

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A project checkout: path → content. Every declared agent gets its `.md`. */
function project(files: Record<string, string>): string {
  const cwd = mkdtempSync(join(tmpdir(), 'kortix-tools-'));
  dirs.push(cwd);
  for (const [path, content] of Object.entries({ 'agents/kortix.md': '---\ndescription: k\n---\nWork.\n', ...files })) {
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
  // `formatIssues` colors its output even with NO_COLOR.
  const plain = (bytes: Buffer) => bytes.toString().replace(/\x1b\[[0-9;]*m/g, '');
  return { code: result.exitCode, stdout: plain(result.stdout), stderr: plain(result.stderr) };
}

const read = (cwd: string, path: string) => readFileSync(join(cwd, path), 'utf8');
const issues = (cwd: string) => JSON.parse(kortix(cwd, 'validate', '--json').stdout).issues as Array<{ path: string; message: string; severity: string }>;

const HEAD = 'kortix_version: 2\ndefault_agent: kortix\nagents:\n  kortix:\n    file: agents/kortix.md\n';
/** The starter's list, with its comments. */
const STARTER_TOOLS = `# ─── Tools ───
# Delete a line to remove that tool from every agent.
tools:
  web_search: kortix:web_search      # maintained by Kortix, updated automatically
  image_search: kortix:image_search
  scrape_webpage: kortix:scrape_webpage
  memory: kortix:memory
  show: kortix:show
  # lookup_order: tools/lookup_order.ts   # your own tool: a module in your repo

# ─── Triggers ───
`;
const LOOKUP = "export default { description: 'Look up an order.', parameters: { type: 'object', properties: {} }, execute: () => 'ok' }\n";

describe('kortix validate — tools: kortix:<name>', () => {
  test('both value forms pass, and a kortix: value needs no file', () => {
    const cwd = project({ 'kortix.yaml': HEAD + STARTER_TOOLS.replace('  # lookup_order', '  lookup_order: tools/lookup_order.ts\n  # x'), 'tools/lookup_order.ts': LOOKUP });
    const result = kortix(cwd, 'validate');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('kortix.yaml is valid');
  }, SPAWN_TEST_MS);

  test('a key/name mismatch and an unknown kortix: name are errors that name the allowed values', () => {
    const cwd = project({ 'kortix.yaml': `${HEAD}tools:\n  web_search: kortix:image_search\n  web_serch: kortix:web_serch\n` });
    const result = kortix(cwd, 'validate');
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('tools.web_search: must be `kortix:web_search` (the Kortix tool) or a repo-relative path');
    expect(result.stderr).toContain('tools.web_serch: must be a repo-relative path to a .ts or .js module (e.g. `tools/web_serch.ts`). `kortix:<name>` names a Kortix tool under its own name: `web_search: kortix:web_search`');
    expect(result.stderr).not.toContain('does not exist in the project files');
  }, SPAWN_TEST_MS);

  test('a tools key with no Kortix tool, and an agent that names a removed one, are warnings', () => {
    const cwd = project({
      'kortix.yaml': `${HEAD}    tools: [read, lookup_order, show]\ntools:\n  lookup_order: tools/lookup_order.ts\n`,
      'tools/lookup_order.ts': LOOKUP,
    });
    const result = kortix(cwd, 'validate', '--json');
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).issues).toEqual([
      {
        path: 'tools',
        message: 'Sessions of this project get no Kortix tool (web_search, image_search, scrape_webpage, memory, show). Add `<name>: kortix:<name>` to keep one.',
        severity: 'warning',
      },
      {
        path: 'agents.kortix.tools',
        message: '"show" is a Kortix tool this project does not load: add `show: kortix:show` under the top-level `tools`, or remove it here.',
        severity: 'warning',
      },
    ]);
  }, SPAWN_TEST_MS);
});

describe('kortix tools ls', () => {
  test('with no tools key, every Kortix tool, and it says why', () => {
    const cwd = project({ 'kortix.yaml': HEAD });
    const result = kortix(cwd, 'tools', 'ls');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('NAME            KIND    SOURCE\nweb_search      kortix  kortix:web_search\nimage_search    kortix  kortix:image_search\n');
    expect(result.stdout).toContain('kortix.yaml has no `tools:` key, so sessions get every Kortix tool.');
    expect(JSON.parse(kortix(cwd, 'tools', 'ls', '--json').stdout)).toMatchObject({ tools_key: false, removed: [] });
  }, SPAWN_TEST_MS);

  test('lists kind and source per tool, the removed Kortix tools, and reads imported files', () => {
    const cwd = project({
      'kortix.yaml': `${HEAD}imports: [team/kortix.yaml]\ntools:\n  web_search: kortix:web_search\n  memory: tools/memory.ts\n`,
      'team/kortix.yaml': 'tools:\n  lookup_order: team/tools/lookup_order.ts\n  show: kortix:show\n',
    });
    const text = kortix(cwd, 'tools', 'ls');
    expect(text.code).toBe(0);
    expect(text.stdout).toContain(
      [
        'NAME          KIND                 SOURCE',
        'web_search    kortix               kortix:web_search',
        'memory        kortix (overridden)  tools/memory.ts',
        'show          kortix               kortix:show',
        'lookup_order  project              team/tools/lookup_order.ts',
        '',
        'Removed Kortix tools: image_search, scrape_webpage',
      ].join('\n'),
    );
    const json = kortix(cwd, 'tools', 'ls', '--json');
    expect(json.code).toBe(0);
    expect(JSON.parse(json.stdout)).toEqual({
      manifest: join(realpathSync(cwd), 'kortix.yaml'),
      tools_key: true,
      tools: [
        { name: 'web_search', kind: 'kortix', source: 'kortix:web_search' },
        { name: 'memory', kind: 'kortix (overridden)', source: 'tools/memory.ts' },
        { name: 'show', kind: 'kortix', source: 'kortix:show' },
        { name: 'lookup_order', kind: 'project', source: 'team/tools/lookup_order.ts' },
      ],
      removed: ['image_search', 'scrape_webpage'],
    });
  }, SPAWN_TEST_MS);

  test('no manifest is exit 2', () => {
    const cwd = project({});
    rmSync(join(cwd, 'agents'), { recursive: true });
    expect(kortix(cwd, 'tools', 'ls').code).toBe(2);
  }, SPAWN_TEST_MS);
});

describe('kortix tools eject', () => {
  test('writes the Kortix source and points kortix.yaml at it; every comment stays', () => {
    const cwd = project({ 'kortix.yaml': HEAD + STARTER_TOOLS });
    const result = kortix(cwd, 'tools', 'eject', 'web_search');
    expect(result.code).toBe(0);
    expect(read(cwd, 'tools/web_search.ts')).toBe((KORTIX_TOOL_SOURCES as Record<string, string>).web_search!);
    // Only the ejected line changed; its trailing comment now says where the file came from.
    expect(read(cwd, 'kortix.yaml')).toBe(
      HEAD + STARTER_TOOLS.replace('web_search: kortix:web_search      # maintained by Kortix, updated automatically', 'web_search: tools/web_search.ts  # ejected from kortix:web_search'),
    );
    expect(result.stdout).toContain('Ejected web_search');
    expect(result.stdout).toContain('2. kortix validate');
    expect(result.stdout).toContain('kortix cr open');
    const after = kortix(cwd, 'validate');
    expect([after.code, after.stdout]).toEqual([0, expect.stringContaining('kortix.yaml is valid')]);
    expect(JSON.parse(kortix(cwd, 'tools', 'ls', '--json').stdout).tools[0]).toEqual({ name: 'web_search', kind: 'kortix (overridden)', source: 'tools/web_search.ts' });
  }, SPAWN_TEST_MS);

  test('with no tools key, it lists the other four Kortix tools so the eject removes nothing', () => {
    const cwd = project({ 'kortix.yaml': `${HEAD}# the end\n` });
    expect(kortix(cwd, 'tools', 'eject', 'show').code).toBe(0);
    expect(read(cwd, 'kortix.yaml')).toBe(
      `${HEAD}# the end\n\ntools:\n  web_search: kortix:web_search\n  image_search: kortix:image_search\n  scrape_webpage: kortix:scrape_webpage\n  memory: kortix:memory\n  show: tools/show.ts  # ejected from kortix:show\n`,
    );
    expect(JSON.parse(kortix(cwd, 'tools', 'ls', '--json').stdout).removed).toEqual([]);
    expect(issues(cwd)).toEqual([]);
  }, SPAWN_TEST_MS);

  test('an entry declared in an imported file is edited in that file', () => {
    const cwd = project({ 'kortix.yaml': `${HEAD}imports: [team.yaml]\n`, 'team.yaml': 'tools:\n  memory: kortix:memory  # team memory\n' });
    expect(kortix(cwd, 'tools', 'eject', 'memory').code).toBe(0);
    expect(read(cwd, 'team.yaml')).toBe('tools:\n  memory: tools/memory.ts  # ejected from kortix:memory\n');
    expect(read(cwd, 'kortix.yaml')).toBe(`${HEAD}imports: [team.yaml]\n`);
    expect(issues(cwd).filter((issue) => issue.severity === 'error')).toEqual([]);
  }, SPAWN_TEST_MS);

  test('refuses an existing file without --force, and a name that is not a Kortix tool', () => {
    const cwd = project({ 'kortix.yaml': HEAD + STARTER_TOOLS, 'tools/memory.ts': 'mine\n' });
    const refused = kortix(cwd, 'tools', 'eject', 'memory');
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('tools/memory.ts exists.');
    expect(read(cwd, 'tools/memory.ts')).toBe('mine\n');
    expect(read(cwd, 'kortix.yaml')).toBe(HEAD + STARTER_TOOLS);

    expect(kortix(cwd, 'tools', 'eject', 'memory', '--force').code).toBe(0);
    expect(read(cwd, 'tools/memory.ts')).toBe((KORTIX_TOOL_SOURCES as Record<string, string>).memory!);

    const unknown = kortix(cwd, 'tools', 'eject', 'lookup_order');
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain('"lookup_order" is not a Kortix tool.');
    expect(unknown.stderr).toContain('Eject one of: web_search, image_search, scrape_webpage, memory, show.');
    expect(existsSync(join(cwd, 'tools/lookup_order.ts'))).toBe(false);
  }, SPAWN_TEST_MS);
});
