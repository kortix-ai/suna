'use client';

/**
 * `/settings/[tab]` — deep-link into the merged Settings overlay with NO
 * project context (e.g. `/settings/profile`, `/settings/billing`). This is
 * the account-scoped door into the same overlay the two
 * `/projects/[id]/settings*` routes open project-scoped — see the "You" and
 * "Organization" rail groups in `rail.ts`, which is why this route exists
 * with no `[id]` segment at all rather than defaulting to some remembered
 * project.
 *
 * **History, because it has flipped twice.** It first rendered `SettingsPanel`
 * directly, which left a blank page once the overlay was closed (nothing sat
 * behind it). It was then changed to set store state and bounce to
 * `PROJECT_LANDING_PATH`, letting `ProjectShell` mount the panel. That fixed
 * the blank page but routed every visitor through `/projects/start`, the door
 * that PROVISIONS a first project — the exact opposite of what the sign-in
 * redirect for a user without app access needs. It now renders the panel
 * directly again, with the blank page fixed properly instead of avoided. The
 * reasoning lives in one place: `standalone-settings-route.tsx`'s header.
 *
 * An unparseable segment opens the panel on the account-scoped default rather
 * than 404ing, matching how the project-scoped sibling treats one.
 */

import { useParams } from 'next/navigation';

import { parseSettingsTab } from '@/features/workspace/settings/settings-tabs';
import {
  STANDALONE_DEFAULT_SETTINGS_TAB,
  StandaloneSettingsRoute,
} from '@/features/workspace/settings/standalone-settings-route';

export default function SettingsTabPage() {
  const params = useParams<{ tab: string }>();
  const tab = parseSettingsTab(params?.tab) ?? STANDALONE_DEFAULT_SETTINGS_TAB;

  return <StandaloneSettingsRoute tab={tab} />;
}
