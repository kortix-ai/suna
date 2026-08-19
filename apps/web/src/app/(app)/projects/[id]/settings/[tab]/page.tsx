'use client';

/**
 * /projects/[id]/settings/[tab] — deep-link entry into the merged Settings
 * overlay for a specific tab (e.g. `/settings/secrets`).
 *
 * Mirrors `customize/[section]/page.tsx`'s parse-or-redirect shape: a
 * segment that resolves through `parseSettingsTab` opens the overlay on it,
 * then bounces to the project home behind it — `ProjectShell` mounts
 * `SettingsPanel` persistently, so this route's only job is to set store
 * state and leave. A segment that is not a live tab but IS a known legacy id
 * (a renamed tab, or a section that graduated to its own page) goes through
 * `legacySectionRedirect` — the same resolution `/customize/[section]` uses —
 * so e.g. a bookmarked `/settings/computers` lands on the Connectors page
 * that owns computers now instead of silently opening the default tab. The
 * same path carries `/settings/schedules` and `/settings/webhooks`: both
 * graduated out of the overlay into their own capability pages, so
 * `parseSettingsTab` returns `null` for them and `legacySectionRedirect`'s
 * `GRADUATED` map sends them to `/projects/[id]/schedules` and
 * `/projects/[id]/webhooks` instead of opening a tab that no longer exists.
 * Anything else (a typo, a truly dead id) falls back to the bare
 * `/projects/[id]/settings` route rather than opening on a tab that doesn't
 * exist.
 *
 * The account-scoped ids (`/settings/billing`, `/settings/api-keys`,
 * `/settings/audit`, ...) go the same way, through
 * `useLegacySectionRedirect` — they need an ACCOUNT id, which this route does
 * not have in hand, so the hook resolves one before the redirect fires. That
 * is also why the effect holds while `pending`: replacing early would drop
 * the destination the bookmark named and land on the bare `/settings`
 * fallback.
 *
 * This page used to render `SettingsPanel` directly, because nothing else
 * mounted it yet. Now that `ProjectShell` does, rendering it here too would
 * stack a second full-viewport `Modal` on the same store — and closing the
 * overlay from THIS route used to leave a blank page, since nothing else was
 * ever rendered here. Redirecting away fixes both.
 */

import { useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';

import { parseSettingsTab } from '@/features/workspace/settings/settings-tabs';
import { useLegacySectionRedirect } from '@/features/workspace/settings/use-account-section-redirect';
import { useSettingsPanelStore } from '@/stores/settings-panel-store';

export default function ProjectSettingsTabPage() {
  const params = useParams<{ id: string; tab: string }>();
  const projectId = params?.id ?? '';
  const tab = parseSettingsTab(params?.tab);
  const router = useRouter();
  // Called unconditionally, and passed the raw segment even when it parses to
  // a live tab — a hook cannot sit behind the `if (!tab)` branch below. It
  // does no work for a segment that is not account-scoped.
  const legacy = useLegacySectionRedirect(projectId, tab ? null : params?.tab);

  useEffect(() => {
    if (!projectId) return;
    if (!tab) {
      // Hold rather than fall back: `pending` means an account-scoped id is
      // still waiting on its account id, and replacing now would send a
      // `/settings/billing` bookmark to the bare overlay instead of the
      // account page it names.
      if (legacy.pending) return;
      // The redirect never returns this same URL for an unparseable segment:
      // it resolves only known legacy ids, and every rename target is a live
      // tab, so it cannot loop back here.
      router.replace(legacy.href ?? `/projects/${projectId}/settings`);
      return;
    }
    useSettingsPanelStore.getState().openSettings(tab);
    router.replace(`/projects/${projectId}`);
  }, [projectId, tab, legacy.href, legacy.pending, router]);

  return null;
}
