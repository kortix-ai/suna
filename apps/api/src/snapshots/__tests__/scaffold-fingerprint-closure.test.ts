import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

const templatesSource = readFileSync(join(import.meta.dir, '..', 'templates.ts'), 'utf8');

describe('standard snapshot scaffold fingerprint closure', () => {
  test('treats the complete starter package as non-agent runtime content', () => {
    const start = templatesSource.indexOf('const NON_AGENT_RUNTIME_ARTIFACTS = [');
    const end = templatesSource.indexOf('];', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const artifacts = templatesSource.slice(start, end);
    expect(artifacts).toContain("label: 'kortix-starter'");
    expect(artifacts).toContain('path: STARTER_ROOT');
    expect(artifacts).toContain('excludeNames: FINGERPRINT_EXCLUDES');
  });
});

test('daemon artifacts include the shared MCP config source and pinned dependency lock', () => {
  const start = templatesSource.indexOf('const AGENT_RUNTIME_ARTIFACTS = [');
  const end = templatesSource.indexOf('];', start);
  const artifacts = templatesSource.slice(start, end);
  expect(artifacts).toContain('packages/sdk/src/core/pi/mcp.ts');
  expect(artifacts).toContain('apps/kortix-sandbox-agent-server/bun.lock');
  const build = readFileSync(join(import.meta.dir, '..', 'build-context.ts'), 'utf8');
  expect(build).toContain("resolve(dir, '../../../packages/sdk/src/core/pi/mcp.ts')");
  expect(build).toContain('agentSharedInputs(dir).map');
  expect(build).toContain('const files: string[] = agentSharedInputs(dir)');
  for (const name of ['api', 'sandbox']) {
    const dockerfile = readFileSync(join(import.meta.dir, '../../../..', name, 'Dockerfile'), 'utf8');
    expect(dockerfile).toContain('COPY packages/sdk/src/core/pi/mcp.ts /repo/packages/sdk/src/core/pi/mcp.ts');
  }
});
