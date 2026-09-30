import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Characterize the JSX contracts without a native runtime: these tokens encode
// the visible variants and controls that must survive a structural extraction.
const read = (file: string) => readFileSync(join(import.meta.dir, file), 'utf8');
const error = read('../tool-error.tsx');
const sections = read('structured-output.tsx');
const row = read('infrastructure.tsx');
const disclosure = read('../../../../lib/session/disclosure-store.ts');

describe('tool renderer shapes', () => {
  test('error keeps validation badges, summary and trace disclosure', () => {
    for (const token of ['validationIssues.map', 'issue.path.join', 'Expected one of:', '{summary}', 'Stack trace', 'accessibilityState={{ expanded: showTrace }}']) {
      expect(error).toContain(token);
    }
  });
  test('structured output keeps all six cases and shared traceback toggle', () => {
    for (const type of ['warning', 'error', 'traceback', 'install', 'info', 'plain']) expect(sections).toContain(`case '${type}':`);
    expect(sections).toContain('setShowTrace((v) => !v)');
    expect(sections).toContain('section.lines.map');
  });
  test('tool row keeps disclosure, latch, lock and activation', () => {
    for (const token of ['resolveDisclosureOpen', 'if (!forceOpen) return', 'if (locked && open) return']) expect(disclosure).toContain(token);
    expect(row).toContain('accessibilityState={{ expanded: open }}');
    expect(row).toContain('onPress={press ? (locked ? undefined : press) : activate}');
  });
});
