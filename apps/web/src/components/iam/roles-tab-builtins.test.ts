// The Roles list is the one place a built-in role is presented as something
// you can look at and duplicate. Owner decision 2026-08-18: Member and
// Manager are the only project roles; `editor` was removed from the engine
// (role-perms.ts) so the list must not carry a client-side filter for it.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(import.meta.dir, 'roles-tab.tsx'), 'utf8');
const flat = source.replace(/\s+/g, ' ');

describe('roles tab built-in list', () => {
  test('carries no client-side filter for a retired editor role — the engine owns the list', () => {
    expect(flat).not.toContain("role.key === 'editor'");
  });

  test('a built-in row is named and described by the shared descriptor, not the API prose', () => {
    expect(source).toContain('builtinRoleDescriptor');
    // The project floor role's API key is `user` and its API name is
    // "Member (read + run)"; the select and the Help page call it "Member".
    // Without this remap the same role reads under two different names.
    expect(flat).toContain("role.key === 'user' ? 'member' : role.key");
    expect(flat).toContain('const title = descriptor?.label ?? role.name;');
  });

  test('it never renders its own role select or assignments table', () => {
    expect(source).not.toContain('PolicyAssignments');
    expect(source).not.toContain('DropdownMenuSub');
  });
});
