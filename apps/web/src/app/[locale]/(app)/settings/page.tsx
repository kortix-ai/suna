'use client';

/**
 * `/settings` — the account-scoped settings URL with no tab segment.
 *
 * Its sibling `[tab]/page.tsx` has always existed; this one did not, so every
 * link to a bare `/settings` 404'd. Both render the same
 * `StandaloneSettingsRoute` (see that file for why this mount does not bounce
 * through `/projects/start`); the only difference is which tab it opens on.
 */

import {
  STANDALONE_DEFAULT_SETTINGS_TAB,
  StandaloneSettingsRoute,
} from '@/features/workspace/settings/standalone-settings-route';

export default function SettingsPage() {
  return <StandaloneSettingsRoute tab={STANDALONE_DEFAULT_SETTINGS_TAB} />;
}
