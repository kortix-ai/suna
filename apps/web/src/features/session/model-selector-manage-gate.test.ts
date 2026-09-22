/**
 * The model picker's writes are `project.customize.write` on the API.
 *
 * The star sets the ACCOUNT default model (the default for every member), and
 * "+" / sliders open the provider modal. A project member without the leaf saw
 * all three and got "You don't have permission to perform this action
 * (project.customize.write)" for the star (dev, 2026-09-22).
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(import.meta.dir, 'model-selector.tsx'), 'utf8');
const code = source.replace(/^[ \t]*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

describe('model picker — management controls follow project.customize.write', () => {
  test('the gate reads the leaf the API asserts, from the shared probe batch', () => {
    expect(code).toContain('const caps = useProjectPageCans(projectId ?? undefined);');
    expect(code).toContain(
      'caps[PROJECT_ACTIONS.PROJECT_CUSTOMIZE_WRITE]?.allowed !== false',
    );
  });

  test('rows get the star only through the gated controls', () => {
    expect(code).toContain(
      'const rowDefaultControls = canManageModels ? defaultControls : undefined;',
    );
    expect(code).not.toContain('defaultControls={defaultControls}');
    expect((code.match(/defaultControls=\{rowDefaultControls\}/g) ?? []).length).toBe(2);
  });

  test('"+" and sliders render only for a viewer who can manage models', () => {
    expect(code).toContain('canManageModels ? (');
  });
});
