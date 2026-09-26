/**
 * A project member opened the overrides gear inside a session and got two dead
 * ends (dev, 2026-09-22): "Secrets — Secret access is unavailable" and a
 * read-only "Sandbox — default / platinum", above a Save button and "Changes
 * apply to the next prompt."
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(import.meta.dir, 'session-overrides-toolbar.tsx'), 'utf8');
const code = source.replace(/^[ \t]*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

describe('session overrides — nothing the viewer cannot change', () => {
  test('the Secrets row is dropped on a settled project.secret.read denial', () => {
    expect(code).toContain('useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_SECRET_READ)');
    expect(code).toContain('const secretsDenied = !secretRead.isLoading && !secretRead.allowed;');
    expect(code).toContain("if (!secretsDenied) list.push({\n      id: 'secrets',");
  });

  test('with only read-only rows left, the gear is not rendered', () => {
    expect(code).toContain('if (rows.every((row) => row.readOnly)) return null;');
  });

  test('Save is hidden when no row writes through it', () => {
    expect(code).toContain(
      "hideSave={!rows.some((row) => row.id === 'secrets' || row.id === 'provider-keys')}",
    );
  });
});
