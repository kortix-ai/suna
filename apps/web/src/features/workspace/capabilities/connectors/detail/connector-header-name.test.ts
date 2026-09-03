import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('connector header rename', () => {
  test('keeps the existing rename mutation on the routed detail header', () => {
    const source = readFileSync(join(import.meta.dir, 'connector-header-name.tsx'), 'utf8');
    expect(source).toContain('setConnectorName(projectId, slug, draft.trim())');
    expect(source).toContain("successToast('Renamed')");
    expect(source).toContain('aria-label="Rename connector"');
    expect(source).toContain('aria-label="Save name"');
  });
});
