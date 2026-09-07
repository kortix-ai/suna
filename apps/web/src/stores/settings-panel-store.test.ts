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

/**
 * The tab ids below are incidental — this store is tab-agnostic and only
 * stores whatever `SettingsTab` it is handed. They used to be `billing`,
 * `secrets`, `usage` and `audit`; every one of those left the overlay (the
 * account-scoped ones for `/accounts/[id]`, the project-scoped ones for
 * `/projects/[id]/customize/settings`), so they were swapped for surviving tabs rather
 * than given a redirect this store knows nothing about. The `members` cases
 * keep their id because `membersTab` is the thing under test there.
 */
describe('useSettingsPanelStore', () => {
  test('defaults to closed, on the default tab, membersTab "people"', () => {
    const state = useSettingsPanelStore.getState();
    expect(state.open).toBe(false);
    expect(state.tab).toBe(DEFAULT_SETTINGS_TAB);
    expect(state.membersTab).toBe('people');
  });

  test('openSettings(undefined) reopens on the last-viewed tab', () => {
    useSettingsPanelStore.getState().setTab('preferences');
    useSettingsPanelStore.getState().close();
    expect(useSettingsPanelStore.getState().open).toBe(false);

    useSettingsPanelStore.getState().openSettings();

    expect(useSettingsPanelStore.getState().open).toBe(true);
    expect(useSettingsPanelStore.getState().tab).toBe('preferences');
  });

  test('openSettings(tab) jumps straight to that tab', () => {
    useSettingsPanelStore.getState().openSettings('connected');
    expect(useSettingsPanelStore.getState().open).toBe(true);
    expect(useSettingsPanelStore.getState().tab).toBe('connected');
  });

  test('openSettings resets membersTab to "people" when no opts are given', () => {
    // Members itself moved to `/projects/[id]/customize/settings?section=members`, but the
    // INTENT still lives here — see `settings/tabs/members-tab-intent.ts`. So
    // this pins the reset against a surviving tab: any open with no explicit
    // opts must clear a pending intent, or a stale 'invite' replays later.
    useSettingsPanelStore.setState({ membersTab: 'invite' });
    useSettingsPanelStore.getState().openSettings('preferences');
    expect(useSettingsPanelStore.getState().membersTab).toBe('people');
  });

  test('openSettings honours an explicit membersTab', () => {
    useSettingsPanelStore.getState().openSettings('preferences', { membersTab: 'invite' });
    expect(useSettingsPanelStore.getState().open).toBe(true);
    expect(useSettingsPanelStore.getState().tab).toBe('preferences');
    expect(useSettingsPanelStore.getState().membersTab).toBe('invite');
  });

  test('setTab changes the tab without touching open', () => {
    useSettingsPanelStore.getState().setTab('connected');
    expect(useSettingsPanelStore.getState().tab).toBe('connected');
    expect(useSettingsPanelStore.getState().open).toBe(false);
  });

  test('close only flips open — the tab is left where it was', () => {
    useSettingsPanelStore.getState().openSettings('preferences');
    useSettingsPanelStore.getState().close();
    expect(useSettingsPanelStore.getState().open).toBe(false);
    expect(useSettingsPanelStore.getState().tab).toBe('preferences');
  });
});
