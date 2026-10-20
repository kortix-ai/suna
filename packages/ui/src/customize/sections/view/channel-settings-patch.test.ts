import { describe, expect, test } from 'bun:test';

import { type ChannelSettings, channelSettingsPatch } from './channel-settings-patch';

const bound: ChannelSettings = {
  agentName: null,
  model: { providerID: 'kortix', modelID: 'codex/gpt-6-sol' },
  conversationPolicy: 'project_open',
};

describe('channelSettingsPatch', () => {
  test('nothing changed: an empty body, so Save stays disabled', () => {
    expect(channelSettingsPatch(bound, { ...bound, model: { ...bound.model! } })).toEqual({});
  });

  test('sends only the field that changed', () => {
    expect(channelSettingsPatch(bound, { ...bound, agentName: 'reviewer' })).toEqual({
      agentName: 'reviewer',
    });
    expect(channelSettingsPatch(bound, { ...bound, conversationPolicy: 'owner_only' })).toEqual({
      conversationPolicy: 'owner_only',
    });
  });

  test('a gateway model goes out as its bare wire id', () => {
    const next = { ...bound, model: { providerID: 'kortix', modelID: 'deepseek-v4.1' } };
    expect(channelSettingsPatch(bound, next)).toEqual({ opencodeModel: 'deepseek-v4.1' });
  });

  test('a native model goes out as provider/model', () => {
    const next = { ...bound, model: { providerID: 'anthropic', modelID: 'claude-sonnet-5-5' } };
    expect(channelSettingsPatch(bound, next)).toEqual({
      opencodeModel: 'anthropic/claude-sonnet-5-5',
    });
  });

  test('back to the defaults sends null, which resets the override', () => {
    const pinned = { ...bound, agentName: 'reviewer' };
    expect(channelSettingsPatch(pinned, { ...pinned, agentName: null, model: null })).toEqual({
      agentName: null,
      opencodeModel: null,
    });
  });

  test('picking a model on an unpinned conversation pins it', () => {
    const unpinned = { ...bound, model: null };
    expect(channelSettingsPatch(unpinned, bound)).toEqual({ opencodeModel: 'codex/gpt-6-sol' });
  });
});
