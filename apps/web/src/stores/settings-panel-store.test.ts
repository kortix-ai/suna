import { beforeEach, describe, expect, test } from 'bun:test';

import { DEFAULT_SETTINGS_TAB } from '@/features/workspace/settings/settings-tabs';
import { useSettingsPanelStore } from './settings-panel-store';

beforeEach(() => {
  useSettingsPanelStore.setState({
    open: false,
    tab: DEFAULT_SETTINGS_TAB,
    membersTab: 'people',
  });
});

describe('useSettingsPanelStore', () => {
  test('defaults to closed, on the default tab, membersTab "people"', () => {
    const state = useSettingsPanelStore.getState();
    expect(state.open).toBe(false);
    expect(state.tab).toBe(DEFAULT_SETTINGS_TAB);
    expect(state.membersTab).toBe('people');
  });

  test('openSettings(undefined) reopens on the last-viewed tab', () => {
    useSettingsPanelStore.getState().setTab('billing');
    useSettingsPanelStore.getState().close();
    expect(useSettingsPanelStore.getState().open).toBe(false);

    useSettingsPanelStore.getState().openSettings();

    expect(useSettingsPanelStore.getState().open).toBe(true);
    expect(useSettingsPanelStore.getState().tab).toBe('billing');
  });

  test('openSettings(tab) jumps straight to that tab', () => {
    useSettingsPanelStore.getState().openSettings('secrets');
    expect(useSettingsPanelStore.getState().open).toBe(true);
    expect(useSettingsPanelStore.getState().tab).toBe('secrets');
  });

  test('openSettings resets membersTab to "people" when no opts are given', () => {
    useSettingsPanelStore.setState({ membersTab: 'invite' });
    useSettingsPanelStore.getState().openSettings('members');
    expect(useSettingsPanelStore.getState().membersTab).toBe('people');
  });

  test('openSettings honours an explicit membersTab', () => {
    useSettingsPanelStore.getState().openSettings('members', { membersTab: 'invite' });
    expect(useSettingsPanelStore.getState().open).toBe(true);
    expect(useSettingsPanelStore.getState().tab).toBe('members');
    expect(useSettingsPanelStore.getState().membersTab).toBe('invite');
  });

  test('setTab changes the tab without touching open', () => {
    useSettingsPanelStore.getState().setTab('usage');
    expect(useSettingsPanelStore.getState().tab).toBe('usage');
    expect(useSettingsPanelStore.getState().open).toBe(false);
  });

  test('close only flips open — the tab is left where it was', () => {
    useSettingsPanelStore.getState().openSettings('audit');
    useSettingsPanelStore.getState().close();
    expect(useSettingsPanelStore.getState().open).toBe(false);
    expect(useSettingsPanelStore.getState().tab).toBe('audit');
  });
});
