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

  // ─── Legacy users' persisted preferences predate `panelMode` entirely — the
  // key is simply absent from the persisted object, so `preferences.panelMode`
  // is `undefined` at runtime (zustand's `persist` merges the persisted blob
  // over the in-memory defaults, but an *old* persisted blob has no key to
  // merge in — the in-memory default from `create()` covers a *fresh* store,
  // not one rehydrated from an old snapshot missing the field entirely).
  // `togglePanelMode` must treat that exactly like 'easy' (every read site in
  // the app already does via `?? 'easy'`), not like some third state that
  // happens to satisfy `undefined === 'easy'` → false → flips to 'easy' again,
  // silently no-opping the "Advanced" button/⌘K command for every such user. ─
  it('togglePanelMode treats a legacy user (panelMode undefined) as easy and flips to advanced', () => {
    useUserPreferencesStore.setState((s) => ({
      preferences: { ...s.preferences, panelMode: undefined as any },
    }));
    expect(useUserPreferencesStore.getState().preferences.panelMode).toBeUndefined();

    useUserPreferencesStore.getState().togglePanelMode();

    expect(useUserPreferencesStore.getState().preferences.panelMode).toBe('advanced');
  });

  it('resetPreferences restores easy', () => {
    useUserPreferencesStore.getState().setPanelMode('advanced');
    useUserPreferencesStore.getState().resetPreferences();
    expect(useUserPreferencesStore.getState().preferences.panelMode).toBe('easy');
  });
});
