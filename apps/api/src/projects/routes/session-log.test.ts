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

  test('an append is idempotent at a seq, and a CONFLICTING one is refused', async () => {
    const source = await routeSource();
    // Replay depends on seq ordering, so a retry must not become a second
    // entry and a different item at a taken seq must not silently win.
    expect(source).toContain('existing.length > 0');
    expect(source).toContain("c.json({ error: 'seq already written' }, 409)");
    expect(source).toMatch(/same \?\s*c\.body\(null, 204\)/);
  });

  test('reads are ordered by seq and bounded appends protect the replay path', async () => {
    const source = await routeSource();
    expect(source).toContain('orderBy(asc(sessionWorkerLog.seq))');
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
