import { describe, expect, it, beforeEach } from 'bun:test';
import { useUserPreferencesStore } from './user-preferences-store';

describe('panelMode', () => {
  beforeEach(() => {
    useUserPreferencesStore.getState().resetPreferences();
  });

  it('defaults to easy', () => {
    expect(useUserPreferencesStore.getState().preferences.panelMode).toBe('easy');
  });

  it('setPanelMode switches to advanced', () => {
    useUserPreferencesStore.getState().setPanelMode('advanced');
    expect(useUserPreferencesStore.getState().preferences.panelMode).toBe('advanced');
  });

  it('togglePanelMode flips between the two modes', () => {
    const { togglePanelMode } = useUserPreferencesStore.getState();
    togglePanelMode();
    expect(useUserPreferencesStore.getState().preferences.panelMode).toBe('advanced');
    togglePanelMode();
    expect(useUserPreferencesStore.getState().preferences.panelMode).toBe('easy');
  });

  it('resetPreferences restores easy', () => {
    useUserPreferencesStore.getState().setPanelMode('advanced');
    useUserPreferencesStore.getState().resetPreferences();
    expect(useUserPreferencesStore.getState().preferences.panelMode).toBe('easy');
  });
});
