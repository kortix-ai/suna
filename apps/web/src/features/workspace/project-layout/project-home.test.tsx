import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(fileURLToPath(new URL('./project-home.tsx', import.meta.url)), 'utf8');

describe('ProjectHome sidebar toggle', () => {
  test('connects collapsed-toggle hover to the sidebar peek controller', () => {
    expect(source).toContain('onPointerEnter={sidebarState ===');
    expect(source).toContain('peekEnter');
    expect(source).toContain('peekLeave');
  });

  // Visibility is not this view's decision any more. It used to inline
  // `isMobileViewport || sidebarState !== 'expanded'`, which is also true on
  // the desktop shell — so this button, `absolute top-2 left-2`, rendered on
  // top of the macOS traffic lights next to the shell's own opener at x=72.
  // The rule (including that desktop clause) is pinned as a truth table in
  // sidebar-opener.test.ts; here we only pin that the view defers to it.
  test('visibility comes from the shared gate, not a local rule', () => {
    const gate = source.slice(
      source.indexOf('const showSidebarToggle ='),
      source.indexOf(';', source.indexOf('const showSidebarToggle =')),
    );
    expect(gate).toContain('useShowPageSidebarOpener()');
    expect(source).toContain('{showSidebarToggle && (');
  });

  test('does not send the project default as an explicit session sandbox override', () => {
    expect(source).not.toContain('sandbox_slug: activeSlug');
  });
});

/**
 * The setup pill row links straight into Customize surfaces. A plain project
 * `member` holds none of project.connector.read / skill.read / agent.read
 * (they sit in EDITOR_EXTRAS, apps/api/src/iam/role-perms.ts), so an ungated
 * row handed that user six buttons and a "forbidden" toast on click. Each pill
 * now probes the SAME leaf its destination asserts, and disappears on an
 * explicit deny.
 */
describe('ProjectHome setup tiles are gated by the permission their destination needs', () => {
  const tileBlock = source.slice(
    source.indexOf('const PROJECT_SETUP_TILES'),
    source.indexOf('const SETUP_TILE_ACTIONS'),
  );

  test('every tile declares the action its destination asserts', () => {
    // One `action:` per tile. A new pill without one is a pill that cannot be
    // gated — the exact regression this row shipped with.
    const tiles = tileBlock.match(/title: '/g) ?? [];
    const actions = tileBlock.match(/action: PROJECT_ACTIONS\./g) ?? [];
    expect(tiles.length).toBeGreaterThan(0);
    expect(actions.length).toBe(tiles.length);
  });

  test('the leaves match TAB_PREFERENCE, the table the Customize rail already uses', () => {
    for (const action of [
      'PROJECT_CONNECTOR_READ',
      'PROJECT_TRIGGER_READ',
      'PROJECT_SKILL_READ',
      'PROJECT_MEMBERS_READ',
      'PROJECT_AGENT_READ',
    ]) {
      expect(tileBlock).toContain(`action: PROJECT_ACTIONS.${action}`);
    }
  });

  test('probes in one batch and hides only on an explicit deny', () => {
    // `allowed !== false`, never `allowed === true`: an in-flight probe reports
    // allowed:false, so a truthiness gate would blank the row on every cold
    // load and pop it back in.
    expect(source).toContain('useProjectCans(projectId, SETUP_TILE_ACTIONS)');
    expect(source).toContain('caps[tile.action]?.allowed !== false');
    expect(source).not.toContain('caps[tile.action]?.allowed === true');
  });

  test('renders nothing rather than an empty strip when every tile is denied', () => {
    expect(source).toContain('if (tiles.length === 0) return null;');
  });
});
