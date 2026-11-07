'use client';

import type { ArtifactType, ArtifactVisibility } from '@kortix/sdk';
import { BrowserIcon, FileTextIcon, GlobeSimpleIcon, LockSimpleIcon, UsersThreeIcon, type Icon } from '@phosphor-icons/react';

export const ARTIFACT_TYPE_ICON: Record<ArtifactType, Icon> = {
  doc: FileTextIcon,
  html: BrowserIcon,
};

export const VISIBILITY_ICON: Record<ArtifactVisibility, Icon> = {
  private: LockSimpleIcon,
  project: UsersThreeIcon,
  public: GlobeSimpleIcon,
};


export function artifactHref(projectId: string, artifactId: string): string {
  return `/workspaces/${projectId}/artifacts/${artifactId}`;
}

/**
 * "3 hours ago" in the viewer's language. Every time shown here is in the past: a server clock a
 * little ahead of this one reads as now, never "in 2 seconds". Under a minute it is "now", which
 * stays true while the text does not tick.
 */
export function relativeTime(iso: string, locale: string): string {
  const seconds = Math.min(0, (Date.parse(iso) - Date.now()) / 1000);
  const fmt = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const abs = Math.abs(seconds);
  if (abs < 60) return fmt.format(0, 'second');
  if (abs < 3600) return fmt.format(Math.round(seconds / 60), 'minute');
  if (abs < 86400) return fmt.format(Math.round(seconds / 3600), 'hour');
  if (abs < 86400 * 30) return fmt.format(Math.round(seconds / 86400), 'day');
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(iso));
}

/** The `sm` UserAvatar's edge in px: an agent's mark tile lines up with a person's face. */
export const AVATAR_SM_EDGE = 22;
