import { expect, test } from 'bun:test';
import { projectNameAction } from './manifest-project-name';

test('a sync renames only when kortix.yaml changes project.name after the first sight', () => {
  // First sight: record the marker, never undo a name set in the app.
  expect(projectNameAction('Old generated name', undefined, 'Renamed in the app')).toBe('mark');
  // Unchanged since the last sync: nothing.
  expect(projectNameAction('Old generated name', 'Old generated name', 'Renamed in the app')).toBe('none');
  // Changed in the file: apply it.
  expect(projectNameAction('Ops', 'Old generated name', 'Renamed in the app')).toBe('apply');
  // Changed to what the row already says: only move the marker.
  expect(projectNameAction('Renamed in the app', 'Old generated name', 'Renamed in the app')).toBe('mark');
  expect(projectNameAction(undefined, 'x', 'y')).toBe('none');
  expect(projectNameAction('  ', 'x', 'y')).toBe('none');
});
