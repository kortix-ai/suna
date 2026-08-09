/**
 * Legacy re-export shim.
 *
 * The Customize overlay, the account settings page, and the user settings
 * modal merged into one settings overlay — see
 * `@/features/workspace/settings/settings-tabs`, the new source of truth.
 * This file only exists so importers who still reference
 * `@/lib/customize-sections` under the old names keep compiling during the
 * migration. New code should import from `settings-tabs` directly; do not
 * add anything new here.
 */

export {
  DEFAULT_SETTINGS_TAB as DEFAULT_CUSTOMIZE_SECTION,
  SETTINGS_TABS as CUSTOMIZE_SECTIONS,
  legacySectionRedirect as legacyCustomizeRedirect,
  parseSettingsTab as parseCustomizeSection,
  resolveSettingsOverlayHref as resolveCustomizeOverlayHref,
  type SettingsTab as CustomizeSection,
  type SettingsOverlayMatch as CustomizeOverlayMatch,
} from '@/features/workspace/settings/settings-tabs';
