import { describe, expect, test } from 'bun:test';
import { selectSessionRowsForViewer } from '../workspaces/lib/session-inventory';

const subject = { userId: 'viewer-1', groupIds: [] } as any;

function row(overrides: Record<string, unknown>) {
  return {
    sessionId: crypto.randomUUID(),
    createdBy: 'owner-1',
    visibility: 'project',
    origin: 'user',
    metadata: {},
    ...overrides,
  } as any;
}

describe('selectSessionRowsForViewer — migrated sessions', () => {
  test("a migrated session (status 'completed', no runtime row) is listed", () => {
    const migrated = row({ status: 'completed' });
    const selected = selectSessionRowsForViewer({
      rows: [migrated],
      scope: 'visible',
      canManageWorkspace: false,
      subject,
      callerSessionId: null,
      grantsBySession: new Map(),
      runtimeStatusBySession: new Map(),
    });
    expect(selected.authorized).toBe(true);
    expect(selected.items.map((i) => i.row.sessionId)).toEqual([migrated.sessionId]);
    expect(selected.items[0]!.canAccess).toBe(true);
  });

  test("a 'stopped' session without a runtime row stays hidden", () => {
    const selected = selectSessionRowsForViewer({
      rows: [row({ status: 'stopped' })],
      scope: 'visible',
      canManageWorkspace: false,
      subject,
      callerSessionId: null,
      grantsBySession: new Map(),
      runtimeStatusBySession: new Map(),
    });
    expect(selected.items).toEqual([]);
  });
});
