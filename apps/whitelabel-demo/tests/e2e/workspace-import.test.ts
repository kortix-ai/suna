import { describe, expect, test } from 'bun:test';
import {
  selectImportableWorkspaces,
  workspaceImportEnabled,
} from '../../src/server/workspace-adoption';

const P = (workspace_id: string, name: string) => ({ workspace_id, name });

describe('selectImportableWorkspaces', () => {
  test('the deprecated Project import env still enables the canonical feature', () => {
    const canonical = process.env.LUMEN_ALLOW_WORKSPACE_IMPORT;
    const legacy = process.env.LUMEN_ALLOW_PROJECT_IMPORT;
    try {
      delete process.env.LUMEN_ALLOW_WORKSPACE_IMPORT;
      process.env.LUMEN_ALLOW_PROJECT_IMPORT = 'true';
      expect(workspaceImportEnabled()).toBe(true);
    } finally {
      if (canonical === undefined) delete process.env.LUMEN_ALLOW_WORKSPACE_IMPORT;
      else process.env.LUMEN_ALLOW_WORKSPACE_IMPORT = canonical;
      if (legacy === undefined) delete process.env.LUMEN_ALLOW_PROJECT_IMPORT;
      else process.env.LUMEN_ALLOW_PROJECT_IMPORT = legacy;
    }
  });

  test('marks what this user already owns instead of hiding it', () => {
    // Hiding owned rows would make the list disagree with the Kortix dashboard,
    // and the operator would wonder which workspaces were missing and why.
    const rows = selectImportableWorkspaces([P('a', 'Alpha'), P('b', 'Beta')], ['a']);
    expect(rows.find((r) => r.workspace_id === 'a')?.imported).toBe(true);
    expect(rows.find((r) => r.workspace_id === 'b')?.imported).toBe(false);
  });

  test('not-yet-imported sort first — those are the actionable rows', () => {
    const rows = selectImportableWorkspaces([P('a', 'Alpha'), P('z', 'Zeta')], ['a']);
    expect(rows[0]?.workspace_id).toBe('z');
  });

  test('a row with no workspace_id is dropped, not rendered blank', () => {
    const rows = selectImportableWorkspaces(
      [{ name: 'nameless' } as never, P('b', 'Beta')],
      [],
    );
    expect(rows).toHaveLength(1);
  });

  test('an absent list is empty, not a crash', () => {
    expect(selectImportableWorkspaces(undefined, [])).toEqual([]);
  });

  test('a missing name still yields a usable row', () => {
    // The id is what the import needs; a blank name must not drop the row.
    const rows = selectImportableWorkspaces([{ workspace_id: 'a' } as never], []);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.workspace_id).toBe('a');
  });
});
