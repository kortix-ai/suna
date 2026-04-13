import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('admin panel XSS safety', () => {
  test('escapes dynamic values before assigning generated HTML', () => {
    const source = readFileSync(join(import.meta.dir, '../admin/index.ts'), 'utf8');

    expect(source).toContain('function escapeHtml(value)');
    expect(source).toContain('escapeHtml(group.title)');
    expect(source).toContain('escapeHtml(inst.name || inst.sandbox_id.slice(0, 8))');
    expect(source).toContain('rel="noopener noreferrer"');
  });
});
