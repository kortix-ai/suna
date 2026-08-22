import { describe, expect, test } from 'bun:test';
import { selectImportableProjects } from '../../src/server/project-adoption';

const P = (project_id: string, name: string) => ({ project_id, name });

describe('selectImportableProjects', () => {
  test('marks what this user already owns instead of hiding it', () => {
    // Hiding owned rows would make the list disagree with the Kortix dashboard,
    // and the operator would wonder which projects were missing and why.
    const rows = selectImportableProjects([P('a', 'Alpha'), P('b', 'Beta')], ['a']);
    expect(rows.find((r) => r.project_id === 'a')?.imported).toBe(true);
    expect(rows.find((r) => r.project_id === 'b')?.imported).toBe(false);
  });

  test('not-yet-imported sort first — those are the actionable rows', () => {
    const rows = selectImportableProjects([P('a', 'Alpha'), P('z', 'Zeta')], ['a']);
    expect(rows[0]?.project_id).toBe('z');
  });

  test('a row with no project_id is dropped, not rendered blank', () => {
    const rows = selectImportableProjects(
      [{ name: 'nameless' } as never, P('b', 'Beta')],
      [],
    );
    expect(rows).toHaveLength(1);
  });

  test('an absent list is empty, not a crash', () => {
    expect(selectImportableProjects(undefined, [])).toEqual([]);
  });

  test('a missing name still yields a usable row', () => {
    // The id is what the import needs; a blank name must not drop the row.
    const rows = selectImportableProjects([{ project_id: 'a' } as never], []);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.project_id).toBe('a');
  });
});
