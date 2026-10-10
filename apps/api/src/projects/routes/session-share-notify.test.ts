/**
 * PUT /{projectId}/sessions/{sessionId}/sharing tells the people a share newly
 * names (KRTX-1742 design §3.2). `setSessionSharing` deletes and re-inserts
 * every grant, so the diff needs the grants read BEFORE it: `visible.grants`,
 * loaded by the route's own access check. The emission runs after the change
 * (the access filter must see the new grants) and is not awaited.
 *
 * Asserted on the handler's source, like turn-questions-authz.test.ts: the
 * route is a registration with no seam to import, and what matters is the
 * order. The diff itself runs on PostgreSQL in
 * __tests__/integration-notification-share.test.ts.
 */
import { describe, expect, test } from 'bun:test';

const SRC = await Bun.file(new URL('./project-sessions.ts', import.meta.url).pathname).text();

function sharingHandler(): string {
  const block = SRC.split('projectsApp.openapi(').find(
    (b) => b.includes("method: 'put'") && b.includes("path: '/{projectId}/sessions/{sessionId}/sharing'"),
  );
  if (!block) throw new Error('no PUT sharing handler in project-sessions.ts');
  return block;
}

describe('PUT sharing → shared with you', () => {
  const src = sharingHandler();

  test('emits after the change, with the grants read before it', () => {
    const visibleAt = src.indexOf('const visible = await loadVisibleSession(');
    const changeAt = src.indexOf('await setSessionSharing(sessionId, intent);');
    const emitAt = src.indexOf('void notifySessionShared({');
    expect(visibleAt).toBeGreaterThan(-1);
    expect(changeAt).toBeGreaterThan(visibleAt);
    expect(emitAt).toBeGreaterThan(changeAt);
    expect(src.slice(emitAt)).toContain('priorGrants: visible.grants');
    // A project-visible session narrowed to members tells nobody (KRTX-1742 review).
    expect(src.slice(emitAt)).toContain('priorVisibility: visible.row.visibility');
  });

  // KRTX-1742 is behind the project's notification_center flag: off, a share
  // tells nobody, as before.
  test('emits only with the project`s notification_center flag on', () => {
    const gateAt = src.indexOf('if (notificationsEnabled(loaded.row.metadata)) {');
    const emitAt = src.indexOf('void notifySessionShared({');
    expect(gateAt).toBeGreaterThan(src.indexOf('await setSessionSharing(sessionId, intent);'));
    expect(emitAt).toBeGreaterThan(gateAt);
    // Nothing but the emission sits between the gate and the call.
    expect(src.slice(gateAt, emitAt).trim()).toBe('if (notificationsEnabled(loaded.row.metadata)) {');
  });

  test('names the caller as the sharer and the session row`s creator', () => {
    const emit = src.slice(src.indexOf('void notifySessionShared({'));
    expect(emit).toContain('sharerId: loaded.userId');
    expect(emit).toContain('creatorId: visible.row.createdBy');
  });
});
