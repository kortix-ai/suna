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
  test('git-token categorically denies every session or agent principal before exporting a credential', async () => {
    const handler = await routeBlock('r1.ts', 'POST /:projectId/git-token');
    const runtimeDeny = handler.indexOf('if (isProjectSessionPrincipal(c))');
    const denialCode = handler.indexOf('runtime_git_credential_export_denied');
    const exportValue = handler.indexOf('push_token: credential.token');
    expect(runtimeDeny).toBeGreaterThan(-1);
    expect(denialCode).toBeGreaterThan(runtimeDeny);
    expect(exportValue).toBeGreaterThan(denialCode);
    expect(handler).not.toContain('assertAgentScopeExact');
  });

  test('provision never returns its upstream push credential to a session or agent principal', async () => {
    const handler = await routeBlock('r1.ts', 'POST /provision');
    const runtimeDeny = handler.indexOf('if (isProjectSessionPrincipal(c)) exportablePushToken = null');
    const exportValue = handler.indexOf('push_token: exportablePushToken');
    expect(runtimeDeny).toBeGreaterThan(-1);
    expect(exportValue).toBeGreaterThan(runtimeDeny);
  });

  test('clone-credential gives runtime principals only the Kortix proxy credential', async () => {
    const handler = await routeBlock('r3.ts', 'GET /:projectId/git/clone-credential');
    const runtimeBranch = handler.indexOf('if (runtimePrincipal)');
    const proxySource = handler.indexOf("source: 'kortix_git_proxy'");
    const upstreamExport = handler.indexOf('token: credential.token');
    expect(runtimeBranch).toBeGreaterThan(-1);
    expect(proxySource).toBeGreaterThan(runtimeBranch);
    expect(upstreamExport).toBeGreaterThan(proxySource);
  });

  test('receive-pack uses a server-owned fence id and the durable task lease', async () => {
    const source = await Bun.file(join(import.meta.dir, '../../git-proxy/index.ts')).text();
    const fenceStart = source.indexOf("suffix === '/git-receive-pack' && auth.taskWorkerSessionId");
    const fenceEnd = source.indexOf('} else {', fenceStart);
    const fence = source.slice(fenceStart, fenceEnd);
    expect(fence).toContain('const requestId = randomUUID()');
    expect(fence).not.toContain("header('x-request-id')");
    expect(fence).toContain('acquireProjectTaskGitWrite');
    expect(fence).toContain('settleProjectTaskGitWrite');
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
