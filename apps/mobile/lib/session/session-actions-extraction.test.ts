import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const sheet = readFileSync(new URL('../../components/session/SessionActionsSheet.tsx', import.meta.url).pathname, 'utf8');
const deletion = sheet + readFileSync(new URL('../../components/session/SessionDeleteDialog.tsx', import.meta.url).pathname, 'utf8');

describe('session action handoff characterization', () => {
  test('delete confirmation begins only when the sheet dismisses', () => {
    expect(sheet).toMatch(/onDismiss=\{handleSheetDismiss\}/);
    expect(sheet).toMatch(/if \(next === 'delete'\) \{[\s\S]*?(?:setConfirmDelete\(session\)|deleteDialogRef\.current\?\.present\(session\))/);
    expect(deletion).toMatch(/if \(!open && !deleteSession\.isPending\) setConfirmDelete\(null\)/);
  });

  test('failed delete restores the optimistic paged-list write', () => {
    expect(deletion).toMatch(/await queryClient\.cancelQueries\(\{ queryKey: pagedKey \}\)/);
    expect(deletion).toMatch(/undo = writeSessionLists\([\s\S]*?withoutSession\(rows, confirmDelete\.session_id\)/);
    expect(deletion).toMatch(/\} catch \{\s*undo\(\);\s*haptics\.warning\(\);\s*setDeleteFailed\(true\)/);
  });
});
