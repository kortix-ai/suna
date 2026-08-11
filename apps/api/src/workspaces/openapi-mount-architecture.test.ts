import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const indexSource = readFileSync(join(import.meta.dir, '..', 'index.ts'), 'utf8');

describe('Workspace OpenAPI mount architecture', () => {
  test('mounts the typed Workspace registry directly under both public namespaces', () => {
    expect(indexSource).toContain("app.route('/v1/workspaces', workspaceRoutesApp)");
    expect(indexSource).toContain("app.route('/v1/projects', workspaceRoutesApp)");
    expect(indexSource).not.toContain("app.route('/v1/workspaces', workspacesApp)");
    expect(indexSource).not.toContain("app.route('/v1/projects', projectsApp)");
  });

  test('keeps response translation at the two namespace boundaries', () => {
    expect(indexSource).toContain(
      "app.use('/v1/workspaces/*', workspaceResponseCompatibility)",
    );
    expect(indexSource).toContain(
      "app.use('/v1/projects/*', projectResponseCompatibility)",
    );
    expect(indexSource).toContain(
      "app.use('/v1/projects/*', projectRequestCompatibility)",
    );
  });
});
