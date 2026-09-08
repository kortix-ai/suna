import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  compilePiAgentModule,
  validatePiAgentFrontmatter,
  resolvePiConfigDir,
} from './pi-agent-module';

async function execute(source: string) {
  const root = await mkdtemp(join(tmpdir(), 'pi-module-proof-'));
  try {
    const file = join(root, 'agent.mjs');
    await writeFile(
      file,
      `import {createRequire as __piCreateRequire} from 'node:module';\n(function(require){${source}\n})(__piCreateRequire(import.meta.url));\nconsole.log(JSON.stringify(await globalThis.__KORTIX_PI_AGENT__({agentName:'reviewer'})));`,
    );
    const child = Bun.spawn(['node', file], { stdout: 'pipe', stderr: 'pipe' });
    const [out, error, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code).toBe(0);
    expect(error).toBe('');
    return JSON.parse(out);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('agent modules compile relative dependencies into standalone JavaScript without executing project code', async () => {
  const files = {
    'agents/reviewer.ts': `import {definePiAgent} from '@kortix/sdk/pi';import {label} from '../label';globalThis.__compilerExecuted = true;export default definePiAgent(ctx=>({thinkingLevel:label}));`,
    'label.ts': `export const label='low';`,
  };
  const result = await compilePiAgentModule({ entry: 'agents/reviewer.ts', files });
  expect((globalThis as any).__compilerExecuted).toBeUndefined();
  expect(await execute(result.source)).toEqual({ thinkingLevel: 'low' });
  expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
  expect((await compilePiAgentModule({ entry: 'agents/reviewer.ts', files })).sha256).toBe(
    result.sha256,
  );
});

test('the compiler rejects missing, escaping, and uninstalled imports instead of falling back to host files', async () => {
  for (const body of [
    `import '../../secret';export default ()=>({});`,
    `import 'missing-dependency';export default ()=>({});`,
    `import '/etc/passwd';export default ()=>({});`,
  ])
    await expect(
      compilePiAgentModule({ entry: 'agents/reviewer.ts', files: { 'agents/reviewer.ts': body } }),
    ).rejects.toThrow();
});

test('Pi config has one explicit source directory and rejects unsupported behavior fields', () => {
  expect(resolvePiConfigDir({ kortix_version: 3 })).toBe('.kortix/pi');
  expect(
    resolvePiConfigDir({ kortix_version: 2, runtime: 'pi', pi: { config_dir: 'agents/pi' } }),
  ).toBe('agents/pi');
  expect(() =>
    resolvePiConfigDir({ kortix_version: 3, pi: { extensions: ['plugin.ts'] } }),
  ).toThrow(/pi.extensions/);
  expect(() => resolvePiConfigDir({ kortix_version: 3, pi: { config_dir: '../outside' } })).toThrow(
    /config_dir/,
  );
  expect(() => resolvePiConfigDir({kortix_version:3, pi:{config_dir:' .kortix/pi '}})).toThrow(/config_dir/);
  for (const fields of [
    { variant: 'fast' },
    { options: { foo: true } },
    { mcp: {} },
    { plugins: [] },
    { temperatur: 0.2 },
  ])
    expect(() => validatePiAgentFrontmatter(fields, 'reviewer')).toThrow(/reviewer/);
  expect(() =>
    validatePiAgentFrontmatter(
      {
        model: 'gpt-5.6-luna',
        temperature: 0.2,
        steps: 3,
        permission: 'ask',
        description: 'reviewer',
      },
      'reviewer',
    ),
  ).not.toThrow();
});

test('compile-time macro imports cannot execute project code on the API', async () => {
  const files = {
    'agents/reviewer.ts': `import {value} from '../macro' with {type:'macro'};export default ()=>({thinkingLevel:value()});`,
    'macro.ts': `export function value(){globalThis.__piMacroExecuted=true;return 'low';}`,
  };
  await expect(compilePiAgentModule({ entry: 'agents/reviewer.ts', files })).rejects.toThrow();
  expect((globalThis as any).__piMacroExecuted).toBeUndefined();
});
