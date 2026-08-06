import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(import.meta.dir, 'account-switcher.tsx'), 'utf8');

describe('AccountSwitcher', () => {
  test('has no sidebar variant — the sidebar uses WorkspaceSwitcher instead', () => {
    expect(source).not.toContain("variant === 'sidebar'");
    expect(source).not.toContain('AccountSwitcherVariant');
    expect(source).not.toContain('SidebarMenuButton');
  });
});
