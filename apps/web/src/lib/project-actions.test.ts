import { describe, expect, test } from 'bun:test';
import {
  CUSTOMIZE_SECTION_GATE_ACTIONS,
  PROJECT_ACTIONS,
  isCustomizeSectionVisible,
} from './project-actions';

// A `can(action)` that returns true for the given allow-list.
const canFrom = (allowed: string[]) => (action: string) => allowed.includes(action);

// A generic set of section READ leaves (agents/skills/commands/connectors/etc.).
const READS = [
  PROJECT_ACTIONS.PROJECT_READ,
  PROJECT_ACTIONS.PROJECT_AGENT_READ,
  PROJECT_ACTIONS.PROJECT_SKILL_READ,
  PROJECT_ACTIONS.PROJECT_COMMAND_READ,
  PROJECT_ACTIONS.PROJECT_CONNECTOR_READ,
  PROJECT_ACTIONS.PROJECT_SECRET_READ,
  PROJECT_ACTIONS.PROJECT_TRIGGER_READ,
  PROJECT_ACTIONS.PROJECT_GITOPS_READ,
  PROJECT_ACTIONS.PROJECT_MEMBERS_READ,
];

describe('isCustomizeSectionVisible — gates on the READ leaf, not write', () => {
  test('a read-only role (read leaves, NO customize.write) STILL SEES the sections (the bug fix)', () => {
    // The old rule required project.customize.write for every section → a
    // read-only / granular role saw a blank panel. Now the read leaf is enough.
    const can = canFrom(READS); // deliberately no customize.write
    expect(isCustomizeSectionVisible('agents', can)).toBe(true);
    expect(isCustomizeSectionVisible('connectors', can)).toBe(true);
    expect(isCustomizeSectionVisible('secrets', can)).toBe(true);
    expect(isCustomizeSectionVisible('schedules', can)).toBe(true);
    expect(isCustomizeSectionVisible('members', can)).toBe(true);
    expect(isCustomizeSectionVisible('settings', can)).toBe(true);
  });

  test("the reported role (customize.read + secret.read) sees the sections it can read", () => {
    const can = canFrom([
      PROJECT_ACTIONS.PROJECT_READ,
      PROJECT_ACTIONS.PROJECT_CUSTOMIZE_READ,
      PROJECT_ACTIONS.PROJECT_SECRET_READ,
    ]);
    expect(isCustomizeSectionVisible('secrets', can)).toBe(true); // has secret.read
    expect(isCustomizeSectionVisible('settings', can)).toBe(true); // gates on project.read
    expect(isCustomizeSectionVisible('agents', can)).toBe(false); // lacks agent.read
  });

  test('a role omitting a specific read leaf hides just that section', () => {
    const can = canFrom(READS.filter((a) => a !== PROJECT_ACTIONS.PROJECT_SECRET_READ));
    expect(isCustomizeSectionVisible('agents', can)).toBe(true);
    expect(isCustomizeSectionVisible('secrets', can)).toBe(false); // read leaf omitted
  });

  test('a role with NO read leaves sees nothing (empty panel, correctly)', () => {
    const can = canFrom([]);
    expect(isCustomizeSectionVisible('agents', can)).toBe(false);
    expect(isCustomizeSectionVisible('secrets', can)).toBe(false);
    expect(isCustomizeSectionVisible('settings', can)).toBe(false);
  });

  test('the probe list is READ leaves only (no customize.write) + deduped', () => {
    expect(CUSTOMIZE_SECTION_GATE_ACTIONS).not.toContain(PROJECT_ACTIONS.PROJECT_CUSTOMIZE_WRITE);
    expect(new Set(CUSTOMIZE_SECTION_GATE_ACTIONS).size).toBe(CUSTOMIZE_SECTION_GATE_ACTIONS.length);
  });
});
