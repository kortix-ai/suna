import { describe, expect, test } from 'bun:test';
import {
  CUSTOMIZE_SECTION_GATE_ACTIONS,
  PROJECT_ACTIONS,
  isCustomizeSectionVisible,
} from './project-actions';

// A `can(action)` that returns true for the given allow-list.
const canFrom = (allowed: string[]) => (action: string) => allowed.includes(action);

// The read leaves a plain `member` (read-only floor) holds — everything READ,
// nothing WRITE. (Mirrors PROJECT_ROLE_PERMS.member in the backend.)
const MEMBER_READS = [
  PROJECT_ACTIONS.PROJECT_READ,
  PROJECT_ACTIONS.PROJECT_AGENT_READ,
  PROJECT_ACTIONS.PROJECT_SKILL_READ,
  PROJECT_ACTIONS.PROJECT_COMMAND_READ,
  PROJECT_ACTIONS.PROJECT_CONNECTOR_READ,
  PROJECT_ACTIONS.PROJECT_SECRET_READ,
  PROJECT_ACTIONS.PROJECT_TRIGGER_READ,
  PROJECT_ACTIONS.PROJECT_GITOPS_READ,
  PROJECT_ACTIONS.PROJECT_FILE_READ,
  PROJECT_ACTIONS.PROJECT_MEMBERS_READ,
];

describe('isCustomizeSectionVisible — member vs editor+', () => {
  test('a member (reads only, no customize.write) sees no customize sections', () => {
    const can = canFrom(MEMBER_READS);
    expect(isCustomizeSectionVisible('agents', can)).toBe(false);
    expect(isCustomizeSectionVisible('connectors', can)).toBe(false);
    expect(isCustomizeSectionVisible('secrets', can)).toBe(false);
    expect(isCustomizeSectionVisible('schedules', can)).toBe(false);
    expect(isCustomizeSectionVisible('members', can)).toBe(false);
    expect(isCustomizeSectionVisible('settings', can)).toBe(false);
  });

  test('an editor (has customize.write + the read leaves) sees the customization sections', () => {
    const can = canFrom([...MEMBER_READS, PROJECT_ACTIONS.PROJECT_CUSTOMIZE_WRITE]);
    expect(isCustomizeSectionVisible('agents', can)).toBe(true);
    expect(isCustomizeSectionVisible('connectors', can)).toBe(true);
    expect(isCustomizeSectionVisible('secrets', can)).toBe(true);
    expect(isCustomizeSectionVisible('schedules', can)).toBe(true);
    expect(isCustomizeSectionVisible('webhooks', can)).toBe(true);
    expect(isCustomizeSectionVisible('members', can)).toBe(true);
    expect(isCustomizeSectionVisible('settings', can)).toBe(true);
  });

  test('a custom role omitting a specific read leaf still hides just that section (editor+)', () => {
    const can = canFrom(
      [...MEMBER_READS, PROJECT_ACTIONS.PROJECT_CUSTOMIZE_WRITE].filter(
        (a) => a !== PROJECT_ACTIONS.PROJECT_SECRET_READ,
      ),
    );
    expect(isCustomizeSectionVisible('agents', can)).toBe(true);
    expect(isCustomizeSectionVisible('secrets', can)).toBe(false); // read leaf omitted
  });

  test('the probe list includes customize.write + is deduped', () => {
    expect(CUSTOMIZE_SECTION_GATE_ACTIONS).toContain(PROJECT_ACTIONS.PROJECT_CUSTOMIZE_WRITE);
    expect(new Set(CUSTOMIZE_SECTION_GATE_ACTIONS).size).toBe(CUSTOMIZE_SECTION_GATE_ACTIONS.length);
  });
});
