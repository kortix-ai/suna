import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PROJECT_ACTIONS } from '@/lib/project-actions';

import { PROJECT_SETUP_TILES, PROJECT_SETUP_TILE_ACTIONS } from './setup-tiles';

const source = readFileSync(join(import.meta.dir, 'setup-tiles.ts'), 'utf8');
const sectionsSource = readFileSync(join(import.meta.dir, 'project-home-sections.tsx'), 'utf8');

/** Every key the checklist can render a row for. A runtime list so the
 *  exhaustiveness checks are real assertions, not a type-level nod. */
const STEP_KEYS = ['connectors', 'triggers', 'skills', 'slack', 'team', 'agent'] as const;

// A source assertion that cannot fail is worse than none. Anchor on something
// that must be present, so a moved or renamed file fails loudly here instead
// of passing vacuously.
describe('the source assertions below are reading the right files', () => {
  test('both files loaded and contain their anchors', () => {
    expect(source).toContain('export const PROJECT_SETUP_TILES');
    expect(sectionsSource).toContain('export function ProjectHomeSections');
  });
});

/**
 * The setup steps are the project's other entry points into Customize. Five of
 * the six land on a capability page; a plain project MEMBER holds none of the
 * leaves those pages assert (#6522 moved `project.customize.read` and the
 * connector/skill/secret/file reads out of PROJECT_MEMBER_BASELINE), so
 * pressing one used to produce a "forbidden" toast. They are hidden now, never
 * disabled.
 */
describe('setup tiles are IAM-gated', () => {
  test('every tile declares the leaves its destination asserts', () => {
    // `actions` is required on SetupTile, so a tile without one is a compile
    // error — this pins that nobody relaxes the field to optional.
    expect((source.match(/actions: \[/g) ?? []).length).toBe(STEP_KEYS.length);
    expect(source).toContain('actions: readonly string[];');
    for (const tile of PROJECT_SETUP_TILES) {
      expect(tile.actions.length).toBeGreaterThan(0);
    }
  });

  // Keyed by `key`, never by `title`. The titles are checklist copy ("Connect
  // a tool", "Invite your team") and rewording one must not be able to break
  // a permission assertion.
  test('the five Customize steps carry the surface leaf AND their own read leaf', () => {
    for (const [key, leaf] of [
      ['connectors', PROJECT_ACTIONS.PROJECT_CONNECTOR_READ],
      ['triggers', PROJECT_ACTIONS.PROJECT_TRIGGER_READ],
      ['skills', PROJECT_ACTIONS.PROJECT_SKILL_READ],
      ['slack', PROJECT_ACTIONS.PROJECT_CONNECTOR_READ],
      ['agent', PROJECT_ACTIONS.PROJECT_AGENT_READ],
    ] as const) {
      const tile = PROJECT_SETUP_TILES.find((t) => t.key === key);
      expect(tile).toBeDefined();
      expect(tile!.actions).toContain(PROJECT_ACTIONS.PROJECT_CUSTOMIZE_READ);
      expect(tile!.actions).toContain(leaf);
      expect(PROJECT_SETUP_TILE_ACTIONS).toContain(leaf);
    }
  });

  // "Invite your team" leaves the project for the account hub's Access tab,
  // which renders read-only for anyone who can read the member list. Gating it
  // on `members.manage` would hide a page a member can legitimately open.
  test('the team step gates on members.READ alone — it is not a Customize page', () => {
    const tile = PROJECT_SETUP_TILES.find((t) => t.key === 'team');
    expect(tile!.actions).toEqual([PROJECT_ACTIONS.PROJECT_MEMBERS_READ]);
    expect(tile!.actions).not.toContain(PROJECT_ACTIONS.PROJECT_CUSTOMIZE_READ);
    expect(tile!.actions).not.toContain(PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE);
  });

  test('one batched probe covers every leaf, deduped and module-level', () => {
    // Six per-tile hooks would fan out six /effective GETs on a page that
    // already fires several. Module-level because `useProjectCans` keys its
    // query on the action list.
    expect(sectionsSource).toContain('useProjectCans(projectId, PROJECT_SETUP_TILE_ACTIONS)');
    expect(new Set(PROJECT_SETUP_TILE_ACTIONS).size).toBe(PROJECT_SETUP_TILE_ACTIONS.length);
    expect(PROJECT_SETUP_TILE_ACTIONS).toContain(PROJECT_ACTIONS.PROJECT_CUSTOMIZE_READ);
  });

  test('hides on a RECEIVED denial only — never mid-probe, never disabled', () => {
    expect(sectionsSource).toContain(
      'tile.actions.every((action) => caps[action]?.allowed !== false)',
    );
    expect(sectionsSource).not.toContain('disabled');
    expect(sectionsSource).toContain('if (tiles.length === 0) return null;');
  });
});

describe('every setup tile carries exactly one step key', () => {
  test('the tiles spell the six step keys, each once', () => {
    expect(PROJECT_SETUP_TILES.map((t) => t.key).sort()).toEqual([...STEP_KEYS].sort());
  });

  // A tile whose key is not a `ProjectSetupStepKey` is a compile error, but a
  // DUPLICATE key is not — and a duplicate means two rows share one probe, so
  // one of them can never complete and the checklist never hides.
  test('no key is used twice', () => {
    const keys = PROJECT_SETUP_TILES.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test('every tile has a non-empty checklist title', () => {
    for (const tile of PROJECT_SETUP_TILES) {
      expect(tile.title.trim().length).toBeGreaterThan(0);
    }
  });
});
