import { describe, expect, test } from 'bun:test';
import { bindingTabs } from './channel-binding-tabs';

describe('bindingTabs', () => {
  test('one tab per platform with a binding, counted: Slack, then Teams, then any other by name', () => {
    expect(
      bindingTabs([
        { platform: 'teams' },
        { platform: 'telegram' },
        { platform: 'slack' },
        { platform: 'teams' },
        { platform: 'email' },
        { platform: 'slack' },
        { platform: 'slack' },
      ]),
    ).toEqual([
      { platform: 'slack', count: 3 },
      { platform: 'teams', count: 2 },
      { platform: 'email', count: 1 },
      { platform: 'telegram', count: 1 },
    ]);
  });

  test('no bindings, no tabs', () => {
    expect(bindingTabs([])).toEqual([]);
  });
});
