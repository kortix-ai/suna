import { expect, test } from 'bun:test';

const cli = new URL('../index.ts', import.meta.url).pathname;
function run(...args: string[]) {
  const result = Bun.spawnSync([process.execPath, cli, 'providers', ...args], {
    env: { ...process.env, KORTIX_DISABLE_SANDBOX_ENV_FILE: '1' },
  });
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
}

test('catalog is discoverable without project credentials and searchable by name', () => {
  const result = run('ls', '--catalog', '--search', 'AnThRoPiC', '--json');
  expect(result.code).toBe(0);
  expect(JSON.parse(result.out).providers).toContainEqual({
    id: 'anthropic', name: 'Anthropic', env: ['ANTHROPIC_API_KEY'],
    doc: 'https://docs.anthropic.com/en/docs/about-claude/models',
  });
});

test('catalog text shows credential names and no-match searches succeed', () => {
  const text = run('list', '--catalog', '--search', 'amazon-bedrock');
  expect(text.code).toBe(0);
  expect(text.out).toContain('AWS_BEARER_TOKEN_BEDROCK');
  expect(text.out).not.toContain('AWS_SECRET_ACCESS_KEY');
  const empty = run('ls', '--catalog', '--search', 'no-such-provider-synthetic', '--json');
  expect(empty.code).toBe(0);
  expect(JSON.parse(empty.out)).toEqual({ providers: [] });
});

test('search requires catalog mode and catalog flags reject writes', () => {
  expect(run('ls', '--search', 'anthropic').code).toBe(2);
  expect(run('set', 'anthropic', '--catalog').code).toBe(2);
  expect(run('ls', '--catalog', '--search').code).toBe(2);
});
