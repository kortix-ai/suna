import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `WorkspaceMenuSection` cannot be rendered here — `apps/web`'s `bun test` has
 * no DOM harness, and this component only ever mounts inside an open Radix
 * `DropdownMenuSubContent`, which renders through a portal. Same constraint,
 * and same source-scan answer, as `workspace-switcher.test.ts`.
 *
 * The DECISIONS behind both rows are pure functions in `workspace-grouping.ts`
 * and are unit-tested there against real inputs
 * (`resolveSwitcherAccountId`, `resolveWorkspaceRowNavigation`). What is left
 * for a source scan is only that this file still WIRES them — the part a
 * refactor can drop silently.
 */
const source = readFileSync(join(import.meta.dir, 'workspace-menu-section.tsx'), 'utf8');
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('WorkspaceMenuSection reaches account settings two ways', () => {
  test('renders an "Account settings" row that navigates to the resolved account', () => {
    // Comments are stripped above, so this file's own prose about the row —
    // and the component's — cannot satisfy the match.
    expect(code).toContain('Account settings');
    expect(code).toContain('router.push(`/accounts/${switcherAccountId}`)');
    expect(code).toContain('resolveSwitcherAccountId({');
  });

  test('the row is withheld, never pointed at `/accounts/null`', () => {
    // `resolveSwitcherAccountId` returns null only while the accounts are
    // unknown; the render must gate on that rather than interpolate it.
    expect(code).toContain('{switcherAccountId ? (');
  });

  test('a workspace row asks where it goes instead of assuming a switch', () => {
    expect(code).toContain('resolveWorkspaceRowNavigation(project, activeProjectId)');
    expect(code).toContain('onSelect={() => openWorkspaceRow(workspace)}');
    // The early `return` this replaced is what made clicking the active row a
    // no-op. It must not come back.
    expect(code).not.toContain('if (project.project_id === activeProjectId) return;');
  });

  test('only a real switch narrates a switch', () => {
    // `beginSwitch` drives the per-row spinner and the project-switch overlay.
    // Firing it for the account-settings navigation would spin a row that is
    // never going to change the active workspace.
    expect(code).toContain("if (target.kind === 'switch') {");
    const beginSwitchCalls = [...code.matchAll(/beginSwitch\(/g)].length;
    expect(beginSwitchCalls).toBe(1);
  });
});
