import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

const templatesSource = readFileSync(join(import.meta.dir, '..', 'templates.ts'), 'utf8');

describe('standard snapshot scaffold fingerprint closure', () => {
  test('treats the complete starter package as non-agent runtime content', () => {
    const start = templatesSource.indexOf('const NON_AGENT_RUNTIME_ARTIFACTS = [');
    const end = templatesSource.indexOf('];', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const artifacts = templatesSource.slice(start, end);
    expect(artifacts).toContain("label: 'kortix-starter'");
    expect(artifacts).toContain('path: STARTER_ROOT');
    expect(artifacts).toContain('excludeNames: FINGERPRINT_EXCLUDES');
  });
});
