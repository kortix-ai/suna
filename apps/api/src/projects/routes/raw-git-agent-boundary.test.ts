import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

async function routeBlock(file: string, summary: string): Promise<string> {
  const source = await Bun.file(join(import.meta.dir, file)).text();
  const start = source.indexOf(`summary: '${summary}'`);
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf('summary:', start + 1);
  return source.slice(start, end > start ? end : source.length);
}

describe('raw git capability boundaries', () => {
  test('git-token requires the literal push grant before exporting a credential', async () => {
    const handler = await routeBlock('r1.ts', 'POST /:projectId/git-token');
    const exactGate = handler.indexOf('assertAgentScopeExact(c, PROJECT_ACTIONS.PROJECT_GITOPS_PUSH)');
    const exportValue = handler.indexOf('push_token: credential.token');
    expect(exactGate).toBeGreaterThan(-1);
    expect(exportValue).toBeGreaterThan(exactGate);
  });

  test('commit-push requires the literal push grant before repository writes', async () => {
    const handler = await routeBlock('r8.ts', 'POST /:projectId/sessions/:sessionId/commit-push');
    const exactGate = handler.indexOf('assertAgentScopeExact(c, PROJECT_ACTIONS.PROJECT_GITOPS_PUSH)');
    const providerWrite = handler.indexOf('/kortix/git/commit-push');
    expect(exactGate).toBeGreaterThan(-1);
    expect(providerWrite).toBeGreaterThan(exactGate);
  });

  test('CR opening retains project.cr.open instead of requiring raw push authorization', async () => {
    const handler = await routeBlock('r8.ts', 'POST /:projectId/change-requests');
    expect(handler).toContain("assertAgentScope(c, 'project.cr.open')");
    expect(handler).not.toContain('assertAgentScopeExact(c, PROJECT_ACTIONS.PROJECT_GITOPS_PUSH)');
  });
});
