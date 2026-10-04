import { describe, expect, test } from 'bun:test';
import { needsSlackNameBackfill } from './channel-bindings';
import type { ChannelBindingRow } from '../../services/channels/slack/selection';

/**
 * `GET /:projectId/channels/bindings` asks Slack to name every Slack row
 * without a stored name. DMs were once excluded: their lookup never named
 * anything and repeated on every poll (measured prod: 29 HTTP calls / 453 ms).
 * A DM is now named after the other person, the name is stored, and a lookup
 * that names nothing is not repeated for 10 minutes
 * (`unit-slack-binding-label.test.ts`).
 */
describe('needsSlackNameBackfill', () => {
  const base: ChannelBindingRow = {
    bindingId: 'b1',
    projectId: 'p1',
    platform: 'slack',
    workspaceId: 'T1',
    channelId: 'C123',
    channelName: null,
    channelType: null,
    agentName: null,
    opencodeModel: null,
    conversationPolicy: 'owner_approval',
    installedAt: new Date('2026-01-01T00:00:00Z'),
  };

  test('a Slack channel with no stored name needs backfill', () => {
    expect(needsSlackNameBackfill(base)).toBe(true);
  });

  test('a Slack channel that already has a name never needs backfill', () => {
    expect(needsSlackNameBackfill({ ...base, channelName: 'general' })).toBe(false);
  });

  test("a Slack DM with no stored name is named after the other person", () => {
    expect(needsSlackNameBackfill({ ...base, channelId: 'D0TEST1' })).toBe(true);
  });

  test('a Teams binding is never selected here regardless of name/channel shape', () => {
    expect(
      needsSlackNameBackfill({ ...base, platform: 'teams', channelType: 'channel' }),
    ).toBe(false);
    expect(
      needsSlackNameBackfill({ ...base, platform: 'teams', channelType: 'personal' }),
    ).toBe(false);
  });

  test('filtering a mixed binding list keeps only the rows worth a Slack call', () => {
    const dm = { ...base, bindingId: 'dm', channelId: 'D999', channelName: null };
    const namedDm = { ...base, bindingId: 'named-dm', channelId: 'D998', channelName: 'Sam Rivera' };
    const namedChannel = { ...base, bindingId: 'named', channelId: 'C1', channelName: 'eng' };
    const unnamedChannel = { ...base, bindingId: 'unnamed', channelId: 'C2', channelName: null };
    const teams = { ...base, bindingId: 'teams', platform: 'teams', channelName: null };

    const result = [dm, namedDm, namedChannel, unnamedChannel, teams].filter(needsSlackNameBackfill);

    expect(result.map((r) => r.bindingId)).toEqual(['dm', 'unnamed']);
  });
});
