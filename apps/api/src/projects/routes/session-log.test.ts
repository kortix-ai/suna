import { describe, expect, test } from 'bun:test';

async function routeSource(): Promise<string> {
  return Bun.file(new URL('./session-log.ts', import.meta.url)).text();
}

// These routes are exercised by a real worker (the appends come from inside a
// sandbox), which the local flow profile cannot stand up, so their security and
// ordering contract is pinned at source level — the same treatment the sibling
// session-environment routes get.
describe('session worker log routes', () => {
  test('a session-scoped caller may only reach its OWN log, before any capability check', async () => {
    const source = await routeSource();
    const gate = source.indexOf('async function authorizeLogCall');
    const load = source.indexOf('loadProjectForUser(c, projectId', gate);
    const selfScope = source.indexOf('callerSession !== sessionId', gate);
    const capability = source.indexOf('assertProjectCapability(', gate);
    expect(gate).toBeGreaterThan(-1);
    expect(load).toBeGreaterThan(gate);
    expect(selfScope).toBeGreaterThan(load);
    expect(capability).toBeGreaterThan(selfScope);
    // A worker's own token must not have to pass the human capability check,
    // and a human must not be able to skip it.
    expect(source.slice(gate, capability)).toContain('if (!callerSession)');
    // Both routes run the same gate.
    expect(source.split('authorizeLogCall(c,').length - 1).toBe(2);
  });

  test('the wire shape is the WORKER\'s: bare item in, bare array out', async () => {
    const source = await routeSource();
    // RemoteSessionLog POSTs `JSON.stringify(item)` and does
    // `(await res.json()) as LogItem[]`. An envelope on either side silently
    // breaks replay: appends 400 and restore iterates nothing.
    expect(source).toContain('const LogItemSchema = z.record(z.unknown());');
    expect(source).toContain('const LogPageSchema = z.array(z.record(z.unknown()));');
    expect(source).toContain('return c.json(rows.map((r) => r.item));');
    expect(source).not.toMatch(/session_id:\s*gate\.sessionId,\s*\n\s*items:/);
  });

  test('reads are in append order and appends are size-bounded', async () => {
    const source = await routeSource();
    // Order IS the contract — replay rebuilds the conversation from it.
    expect(source).toContain('orderBy(asc(sessionWorkerLog.id))');
    expect(source).toContain('MAX_ITEM_BYTES');
    expect(source).toContain("c.json({ error: 'log item too large' }, 413)");
  });

  test('the read path touches no runtime — that is the whole point of P1.8', async () => {
    const source = await routeSource();
    // If this ever reaches for a sandbox, "history readable with nothing
    // running" is gone and the wake-the-box delay is back.
    for (const forbidden of ['sessionSandboxes', 'ensureSessionEnvironment', 'forwardToSandbox']) {
      expect(source).not.toContain(forbidden);
    }
  });
});
