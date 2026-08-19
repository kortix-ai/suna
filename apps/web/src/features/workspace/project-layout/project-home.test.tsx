import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { PROJECT_ACTIONS } from '@/lib/project-actions';

import { PROJECT_SETUP_TILE_ACTIONS } from './project-home';

const source = readFileSync(fileURLToPath(new URL('./project-home.tsx', import.meta.url)), 'utf8');
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

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
 * The setup chips at the bottom of the hero are the project's other entry
 * points into Customize. Five of the six land on a capability page; a plain
 * project MEMBER holds none of the leaves those pages assert (#6522 moved
 * `project.customize.read` and the connector/skill/secret/file reads out of
 * PROJECT_MEMBER_BASELINE), so pressing one used to produce a "forbidden"
 * toast. They are hidden now, never disabled.
 */
describe('ProjectHome setup tiles are IAM-gated', () => {
  const tileBlock = code.slice(
    code.indexOf('const PROJECT_SETUP_TILES'),
    code.indexOf('export const PROJECT_SETUP_TILE_ACTIONS'),
  );

  test('every tile declares the leaves its destination asserts', () => {
    // Six tiles, six `actions:` lists. A new tile without one is a compile
    // error (`actions` is required on SetupTile) — this pins that nobody
    // relaxes the field to optional.
    expect((tileBlock.match(/title: '/g) ?? []).length).toBe(6);
    expect((tileBlock.match(/actions: \[/g) ?? []).length).toBe(6);
    expect(source).toContain('actions: readonly string[];');
  });

  test('the five Customize tiles carry the surface leaf AND their own read leaf', () => {
    // customize.read is the gate on the surface itself; the second leaf is
    // the page. A custom role can hold one and not the other.
    for (const [title, leaf] of [
      ['Connectors', PROJECT_ACTIONS.PROJECT_CONNECTOR_READ],
      ['Triggers', PROJECT_ACTIONS.PROJECT_TRIGGER_READ],
      ['Skills', PROJECT_ACTIONS.PROJECT_SKILL_READ],
      ['Slack', PROJECT_ACTIONS.PROJECT_CONNECTOR_READ],
      ['Agent', PROJECT_ACTIONS.PROJECT_AGENT_READ],
    ] as const) {
      const start = tileBlock.indexOf(`title: '${title}'`);
      const tile = tileBlock.slice(start, tileBlock.indexOf('},', start));
      expect(tile).toContain('PROJECT_ACTIONS.PROJECT_CUSTOMIZE_READ');
      expect(PROJECT_SETUP_TILE_ACTIONS).toContain(leaf);
      expect(tile).toContain(leaf.replace('project.', 'PROJECT_').toUpperCase().replace(/\./g, '_'));
    }
  });

  // "Your team" leaves the project for the account hub's Access tab, which
  // renders read-only for anyone who can read the member list. Gating it on
  // `members.manage` would hide a page a member can legitimately open.
  test('Your team gates on members.READ alone — it is not a Customize page', () => {
    const start = tileBlock.indexOf("title: 'Your team'");
    const tile = tileBlock.slice(start, tileBlock.indexOf('},', start));
    expect(tile).toContain('actions: [PROJECT_ACTIONS.PROJECT_MEMBERS_READ]');
    expect(tile).not.toContain('PROJECT_CUSTOMIZE_READ');
    expect(tile).not.toContain('PROJECT_MEMBERS_MANAGE');
  });

  test('one batched probe covers every leaf, deduped and module-level', () => {
    // Six per-tile hooks would fan out six /effective GETs on a page that
    // already fires several. Module-level because `useProjectCans` keys its
    // query on the action list.
    expect(code).toContain('useProjectCans(projectId, PROJECT_SETUP_TILE_ACTIONS)');
    expect(new Set(PROJECT_SETUP_TILE_ACTIONS).size).toBe(PROJECT_SETUP_TILE_ACTIONS.length);
    expect(PROJECT_SETUP_TILE_ACTIONS).toContain(PROJECT_ACTIONS.PROJECT_CUSTOMIZE_READ);
  });

  test('hides on a RECEIVED denial only — never mid-probe, never disabled', () => {
    expect(code).toContain("tile.actions.every((action) => caps[action]?.allowed !== false)");
    const sections = code.slice(code.indexOf('function ProjectHomeSections'));
    expect(sections).not.toContain('disabled');
    expect(sections).toContain('if (tiles.length === 0) return null;');
  });

  // `GET /projects/:id/access-requests` asserts project.members.manage, so
  // firing it for a member was a guaranteed 403. `showErrors: false` only hid
  // the toast; the request still went out and still failed.
  test('the pending-access bell probes members.manage before it fetches', () => {
    expect(code).toContain(
      'useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE).allowed === true',
    );
    const query = code.slice(
      code.indexOf('queryKey: qk.project.accessRequests(projectId)'),
      code.indexOf('const pendingAccessCount'),
    );
    expect(query).toContain('enabled: canManageMembers');
  });
});
