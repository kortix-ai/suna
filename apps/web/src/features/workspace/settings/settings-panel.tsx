'use client';

/**
 * The Settings overlay's mount point: always rendered by project-shell.tsx and
 * the standalone /settings route, and deliberately tiny.
 *
 * Why it is split (2026-09-27): the panel body imports every settings tab,
 * both project-icon pickers and the rail. Mounted on every project page, that
 * code shipped with the project home even though Settings is closed nearly
 * all of the time — on dev the chunks it pulled in included a 338 KB one
 * (frimousse + the 202-glyph registry) and ~500 KB of tab code. The body now
 * loads the first time the panel opens and stays mounted after, so reopening
 * is instant and the close animation still plays.
 *
 * Mod+, stays bound here, while the panel is closed: the keystroke is how it
 * opens, so it cannot live in the lazily loaded body.
 */

import dynamic from 'next/dynamic';
import { useState } from 'react';

import { useSettingsPanelStore } from '@/stores/settings-panel-store';
import { useSettingsKeyboardShortcut } from './use-settings-shortcut';

const SettingsPanelBody = dynamic(
  () => import('./settings-panel-body').then((m) => m.SettingsPanelBody),
  { ssr: false },
);

/** Start loading the panel body; for triggers that can prefetch on intent. */
export function preloadSettingsPanel(): void {
  void import('./settings-panel-body');
}

export function SettingsPanel({ projectId }: { projectId?: string }) {
  // Mod+, lives with the panel, not with whatever row happens to link to it —
  // binding it here is what makes the keystroke work on every surface that
  // mounts this component, and impossible to advertise on one that doesn't.
  useSettingsKeyboardShortcut();

  const open = useSettingsPanelStore((s) => s.open);
  const [opened, setOpened] = useState(open);
  if (open && !opened) setOpened(true);
  if (!opened) return null;
  return <SettingsPanelBody projectId={projectId} />;
}
