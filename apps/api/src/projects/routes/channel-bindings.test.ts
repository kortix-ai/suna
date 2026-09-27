import { describe, expect, test } from 'bun:test';
import { needsSlackNameBackfill } from './channel-bindings';
import type { ChannelBindingRow } from '../../channels/slack/selection';

/**
 * `GET /:projectId/channels/bindings` used to call `backfillChannelName` for
 * every Slack row missing a `channelName`, including DMs — whose Slack
 * `conversations.info` never returns a `name` at all, so the call always
 * comes back null and gets retried on EVERY future poll forever. Measured
 * prod: 29 wasted HTTP calls / 453ms on a project whose bindings were mostly
 * DMs. `needsSlackNameBackfill` is the fix's single source of truth for
 * "is this row worth a Slack round trip" — pinned here so a future edit to
 * `oneToOneConversation` or this predicate can't silently reintroduce the
 * wasted calls.
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

  test('a Slack DM (channelId starts with D) never needs backfill, even with no name', () => {
    expect(needsSlackNameBackfill({ ...base, channelId: 'D0AENS5MHK9' })).toBe(false);
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
    const namedChannel = { ...base, bindingId: 'named', channelId: 'C1', channelName: 'eng' };
    const unnamedChannel = { ...base, bindingId: 'unnamed', channelId: 'C2', channelName: null };
    const teams = { ...base, bindingId: 'teams', platform: 'teams', channelName: null };

    const result = [dm, namedChannel, unnamedChannel, teams].filter(needsSlackNameBackfill);

    expect(result.map((r) => r.bindingId)).toEqual(['unnamed']);
  });
});
