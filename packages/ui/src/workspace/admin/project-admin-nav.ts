import { buildStandaloneCapabilityNav } from '../../customize/shared/standalone-settings-nav';
import type { SettingsNav } from '../../internal/layout/settings-nav-context';
import { useSettingsPanelStore, type MembersTab } from '../../internal/stores/settings-panel-store';

import { projectAdminHref, projectAdminNavTarget, type ProjectAdminSectionKey } from './project-admin-sections';

/**
 * The `SettingsNav` for panes mounted in Project admin. Panes still speak the
 * overlay's vocabulary (`navigate('llm-providers')`, `navigate('experimental')`):
 * an id that names a section of this page stays on this page. Everything else
 * (`members`, `review`, account sections, personal overlay tabs) resolves the
 * way it does on every standalone capability page.
 *
 * It catches `navigate(tab)` calls only. A pane that pushes its own route
 * (ConnectorsPage opening a connector) still leaves this page.
 */
export function buildProjectAdminNav(state: {
  projectId: string;
  section: ProjectAdminSectionKey;
  membersTab: MembersTab;
  accountId?: string;
  navigateTo: (href: string) => void;
}): SettingsNav {
  const fallback = buildStandaloneCapabilityNav({
    projectId: state.projectId,
    activeTab: state.section,
    membersTab: state.membersTab,
    accountId: state.accountId,
    navigateTo: state.navigateTo,
  });
  return {
    ...fallback,
    navigate: (tab, opts) => {
      const target = projectAdminNavTarget(tab);
      if (!target) {
        fallback.navigate(tab, opts);
        return;
      }
      if (opts?.membersTab) {
        useSettingsPanelStore.setState({ membersTab: opts.membersTab as MembersTab });
      }
      if (tab === 'channels') {
        state.navigateTo(projectAdminHref(state.projectId, 'connectors', { scope: 'channels' }));
      } else if (target !== state.section) {
        state.navigateTo(projectAdminHref(state.projectId, target));
      }
    },
  };
}
