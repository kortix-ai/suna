import { beforeEach, describe, expect, test } from 'bun:test';

import { useCustomizeStore } from '@/stores/customize-store';
import { buildCustomizeSettingsNav } from './customize-panel';

/**
 * `buildCustomizeSettingsNav` is the pure adapter `customize-panel.tsx` uses
 * to build the `SettingsNav` value it hands the five `customize/sections/**`
 * views through `SettingsNavProvider`. It's pure with respect to its input
 * snapshot; `navigate` still writes through the real store, so these run
 * against the actual `useCustomizeStore` (same idiom as
 * `stores/customize-store.test.ts`) rather than a mock.
 */
beforeEach(() => {
  useCustomizeStore.setState({
    open: false,
    section: 'secrets',
    llmProvidersTab: 'catalog',
    membersTab: 'people',
  });
});

describe('buildCustomizeSettingsNav — field mapping', () => {
  test('maps open/section/membersTab/llmProvidersTab straight across', () => {
    const nav = buildCustomizeSettingsNav({
      open: true,
      section: 'members',
      membersTab: 'invite',
      llmProvidersTab: 'models',
    });
    expect(nav.isOpen).toBe(true);
    expect(nav.activeTab).toBe('members');
    expect(nav.membersTab).toBe('invite');
    expect(nav.llmProvidersTab).toBe('models');
  });

  test('reports isOpen: false verbatim — it does not coerce a closed panel to true', () => {
    const nav = buildCustomizeSettingsNav({
      open: false,
      section: 'secrets',
      membersTab: 'people',
      llmProvidersTab: 'catalog',
    });
    expect(nav.isOpen).toBe(false);
  });
});

describe('buildCustomizeSettingsNav — navigate()', () => {
  test('switches the section on the live store', () => {
    const nav = buildCustomizeSettingsNav(useCustomizeStore.getState());
    nav.navigate('computers');
    expect(useCustomizeStore.getState().section).toBe('computers');
  });

  test('does not reset membersTab or llmProvidersTab as a side effect (unlike openCustomize)', () => {
    useCustomizeStore.setState({ llmProvidersTab: 'models', membersTab: 'invite' });
    const nav = buildCustomizeSettingsNav(useCustomizeStore.getState());
    nav.navigate('marketplace');
    expect(useCustomizeStore.getState().llmProvidersTab).toBe('models');
    expect(useCustomizeStore.getState().membersTab).toBe('invite');
  });

  test('does not touch open — matches setSection, not openCustomize', () => {
    useCustomizeStore.setState({ open: true });
    const nav = buildCustomizeSettingsNav(useCustomizeStore.getState());
    nav.navigate('llm-providers');
    expect(useCustomizeStore.getState().open).toBe(true);
    expect(useCustomizeStore.getState().section).toBe('llm-providers');
  });

  test('an explicit membersTab opt sets membersTab on the live store', () => {
    const nav = buildCustomizeSettingsNav(useCustomizeStore.getState());
    nav.navigate('members', { membersTab: 'invite' });
    expect(useCustomizeStore.getState().section).toBe('members');
    expect(useCustomizeStore.getState().membersTab).toBe('invite');
  });

  test('omitting opts leaves membersTab untouched', () => {
    useCustomizeStore.setState({ membersTab: 'invite' });
    const nav = buildCustomizeSettingsNav(useCustomizeStore.getState());
    nav.navigate('members');
    expect(useCustomizeStore.getState().membersTab).toBe('invite');
  });
});
