import { beforeEach, describe, expect, test } from 'bun:test';

import { useCustomizeStore } from './customize-store';

beforeEach(() => {
  useCustomizeStore.setState({
    open: false,
    section: 'agents',
    llmProvidersTab: 'catalog',
    membersTab: 'people',
  });
});

describe('useCustomizeStore', () => {
  test('defaults membersTab to "people"', () => {
    expect(useCustomizeStore.getState().membersTab).toBe('people');
  });

  test('openCustomize resets membersTab to "people" when no opts are given', () => {
    useCustomizeStore.setState({ membersTab: 'invite' });
    useCustomizeStore.getState().openCustomize('members');
    expect(useCustomizeStore.getState().membersTab).toBe('people');
  });

  test('openCustomize honours an explicit membersTab', () => {
    useCustomizeStore.getState().openCustomize('members', { membersTab: 'invite' });
    expect(useCustomizeStore.getState().open).toBe(true);
    expect(useCustomizeStore.getState().section).toBe('members');
    expect(useCustomizeStore.getState().membersTab).toBe('invite');
  });

  test('membersTab and llmProvidersTab reset independently on open', () => {
    useCustomizeStore.getState().openCustomize('llm-providers', {
      llmProvidersTab: 'models',
      membersTab: 'invite',
    });
    expect(useCustomizeStore.getState().llmProvidersTab).toBe('models');
    expect(useCustomizeStore.getState().membersTab).toBe('invite');

    useCustomizeStore.getState().openCustomize('members');
    expect(useCustomizeStore.getState().llmProvidersTab).toBe('catalog');
    expect(useCustomizeStore.getState().membersTab).toBe('people');
  });
});
