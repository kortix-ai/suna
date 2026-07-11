import { describe, expect, test } from 'bun:test';

// Keep config validation happy when commands.ts's import graph loads.
process.env.SLACK_REQUIRE_USER_IDENTITY = 'false';

import { buildAgentUnavailablePickerBlocks } from '../commands';

// The deleted-agent recovery picker: names the dead agent and renders one
// clickable row per current agent, each wired to the existing `set_agent_*`
// interactivity handler (interactivity.ts → handleSetSelection), so a click
// re-points the channel binding and the user just re-sends.
describe('buildAgentUnavailablePickerBlocks', () => {
  const agents = [
    { name: 'shipper', description: 'Ships things.' },
    { name: 'reviewer', description: null },
  ];

  test('names the dead channel-override agent in the lead', () => {
    const blocks = buildAgentUnavailablePickerBlocks({ channelId: 'C1', badAgent: 'ghost', agents });
    const lead = JSON.stringify(blocks[0]);
    expect(lead).toContain('ghost');
    expect(lead.toLowerCase()).toContain('no longer exists');
  });

  test('renders a set_agent_* button per agent, plus the always-present default', () => {
    const blocks = buildAgentUnavailablePickerBlocks({ channelId: 'C1', badAgent: 'ghost', agents });
    const json = JSON.stringify(blocks);
    expect(json).toContain('set_agent_default');
    expect(json).toContain('set_agent_shipper');
    expect(json).toContain('set_agent_reviewer');
    // Every button's value carries the channel (so the existing set_agent_*
    // handler updates THIS channel's binding) and its target agent name.
    const buttons = blocks
      .map((b) => (b as any).accessory)
      .filter((a) => a && a.action_id?.startsWith('set_agent_'))
      .map((a) => JSON.parse(a.value as string) as { c?: string; a?: string });
    expect(buttons.length).toBe(3);
    expect(buttons.every((v) => v.c === 'C1')).toBe(true);
    // `default` clears the override (empty a); the two real agents name themselves.
    expect(buttons.map((v) => v.a).sort()).toEqual(['', 'reviewer', 'shipper']);
  });

  test('null badAgent (broken default sentinel) still renders the picker', () => {
    const blocks = buildAgentUnavailablePickerBlocks({ channelId: 'C1', badAgent: null, agents });
    expect(JSON.stringify(blocks[0]).toLowerCase()).toContain("channel's default agent");
    expect(JSON.stringify(blocks)).toContain('set_agent_shipper');
  });

  test('the dead agent is not marked as the current selection (no false ✓)', () => {
    const blocks = buildAgentUnavailablePickerBlocks({ channelId: 'C1', badAgent: 'ghost', agents });
    // 'ghost' isn't in the list, so no row should carry the ✓ current marker.
    expect(JSON.stringify(blocks)).not.toContain('✓ Current');
  });
});
