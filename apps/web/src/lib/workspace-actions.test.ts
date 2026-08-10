import { describe, expect, test } from 'bun:test';
import {
  CUSTOMIZE_SECTION_GATE_ACTIONS,
  WORKSPACE_ACTIONS,
  isCustomizeSectionVisible,
} from './workspace-actions';

// A `can(action)` that returns true for the given allow-list.
const canFrom = (allowed: string[]) => (action: string) => allowed.includes(action);

// A generic set of section READ leaves (agents/secrets/channels/etc.).
const READS = [
  WORKSPACE_ACTIONS.WORKSPACE_READ,
  WORKSPACE_ACTIONS.WORKSPACE_AGENT_READ,
  WORKSPACE_ACTIONS.WORKSPACE_COMMAND_READ,
  WORKSPACE_ACTIONS.WORKSPACE_CONNECTOR_READ,
  WORKSPACE_ACTIONS.WORKSPACE_SECRET_READ,
  WORKSPACE_ACTIONS.WORKSPACE_TRIGGER_READ,
  WORKSPACE_ACTIONS.WORKSPACE_GITOPS_READ,
  WORKSPACE_ACTIONS.WORKSPACE_MEMBERS_READ,
];

describe('isCustomizeSectionVisible — gates on the READ leaf, not write', () => {
  test('a read-only role (read leaves, NO customize.write) STILL SEES the sections (the bug fix)', () => {
    // The old rule required project.customize.write for every section → a
    // read-only / granular role saw a blank panel. Now the read leaf is enough.
    const can = canFrom(READS); // deliberately no customize.write
    // No `agents` here — it graduated to /projects/<id>/agent and is not a
    // customize section anymore. `commands` came back into the overlay.
    expect(isCustomizeSectionVisible('commands', can)).toBe(true);
    expect(isCustomizeSectionVisible('channels', can)).toBe(true);
    expect(isCustomizeSectionVisible('git', can)).toBe(true);
    expect(isCustomizeSectionVisible('secrets', can)).toBe(true);
    expect(isCustomizeSectionVisible('schedules', can)).toBe(true);
    expect(isCustomizeSectionVisible('members', can)).toBe(true);
    expect(isCustomizeSectionVisible('settings', can)).toBe(true);
  });

  test('the reported role (customize.read + secret.read) sees the sections it can read', () => {
    const can = canFrom([
      WORKSPACE_ACTIONS.WORKSPACE_READ,
      WORKSPACE_ACTIONS.WORKSPACE_CUSTOMIZE_READ,
      WORKSPACE_ACTIONS.WORKSPACE_SECRET_READ,
    ]);
    expect(isCustomizeSectionVisible('secrets', can)).toBe(true); // has secret.read
    expect(isCustomizeSectionVisible('settings', can)).toBe(true); // gates on project.read
    expect(isCustomizeSectionVisible('channels', can)).toBe(false); // lacks connector.read
  });

  test('a role omitting a specific read leaf hides just that section', () => {
    const can = canFrom(READS.filter((a) => a !== WORKSPACE_ACTIONS.WORKSPACE_SECRET_READ));
    expect(isCustomizeSectionVisible('channels', can)).toBe(true);
    expect(isCustomizeSectionVisible('secrets', can)).toBe(false); // read leaf omitted
  });

  test('commands visibility requires project.command.read', () => {
    expect(
      isCustomizeSectionVisible('commands', canFrom([WORKSPACE_ACTIONS.WORKSPACE_COMMAND_READ])),
    ).toBe(true);
    expect(isCustomizeSectionVisible('commands', canFrom([]))).toBe(false);
  });

  test('a role with NO read leaves sees nothing (empty panel, correctly)', () => {
    const can = canFrom([]);
    expect(isCustomizeSectionVisible('channels', can)).toBe(false);
    expect(isCustomizeSectionVisible('secrets', can)).toBe(false);
    expect(isCustomizeSectionVisible('settings', can)).toBe(false);
  });

  test('the probe list is READ leaves only (no customize.write) + deduped', () => {
    expect(CUSTOMIZE_SECTION_GATE_ACTIONS).not.toContain(WORKSPACE_ACTIONS.WORKSPACE_CUSTOMIZE_WRITE);
    expect(new Set(CUSTOMIZE_SECTION_GATE_ACTIONS).size).toBe(
      CUSTOMIZE_SECTION_GATE_ACTIONS.length,
    );
  });
});
