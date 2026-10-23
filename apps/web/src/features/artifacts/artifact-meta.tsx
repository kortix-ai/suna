'use client';

import type { ArtifactType, ArtifactVisibility } from '@kortix/sdk';
import { framePolicy } from '@kortix/ui/file-viewer';
import {
  BrowserIcon,
  ChartBarIcon,
  FileTextIcon,
  GlobeSimpleIcon,
  LockSimpleIcon,
  PaletteIcon,
  PresentationIcon,
  UsersThreeIcon,
  type Icon,
} from '@phosphor-icons/react';
import { forwardRef, useState } from 'react';

export const ARTIFACT_TYPE_ICON: Record<ArtifactType, Icon> = {
  doc: FileTextIcon,
  slides: PresentationIcon,
  board: PaletteIcon,
  dashboard: ChartBarIcon,
  page: BrowserIcon,
};

export const VISIBILITY_ICON: Record<ArtifactVisibility, Icon> = {
  private: LockSimpleIcon,
  project: UsersThreeIcon,
  public: GlobeSimpleIcon,
};

/**
 * The frame's canvas: a third-party page with no background of its own reads
 * as a white page, as it would in a browser tab, in both themes.
 */
const ARTIFACT_CANVAS = 'bg-white';

/** The types offered under "Make something new", in order. */
export const CREATE_TYPES: ArtifactType[] = ['doc', 'slides', 'board', 'dashboard'];

export function artifactHref(projectId: string, artifactId: string): string {
  return `/projects/${projectId}/artifacts/${artifactId}`;
}

/** "3 hours ago" in the viewer's language. */
export function relativeTime(iso: string, locale: string): string {
  const seconds = (Date.parse(iso) - Date.now()) / 1000;
  const fmt = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const abs = Math.abs(seconds);
  if (abs < 60) return fmt.format(Math.round(seconds), 'second');
  if (abs < 3600) return fmt.format(Math.round(seconds / 60), 'minute');
  if (abs < 86400) return fmt.format(Math.round(seconds / 3600), 'hour');
  if (abs < 86400 * 30) return fmt.format(Math.round(seconds / 86400), 'day');
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(iso));
}

/**
 * The signed view URL changes on every read (a fresh token), and a new `src`
 * reloads the frame. Keep the first URL per artifact version, so a background
 * refetch never reloads the page under the reader.
 */
export function useStableViewUrl(key: string | null, url: string | undefined): string | undefined {
  const [stable, setStable] = useState<{ key: string; url: string } | null>(null);
  if (key && url && stable?.key !== key) setStable({ key, url });
  return key && stable?.key === key ? stable.url : url;
}

/**
 * An artifact page. The content server already answers with a CSP sandbox
 * without same-origin; the iframe sandbox repeats it, so the page never runs
 * with this app's origin.
 */
export const ArtifactFrame = forwardRef<HTMLIFrameElement, { src: string; title: string; className?: string; preview?: boolean }>(
  function ArtifactFrame({ src, title, className, preview }, ref) {
    return (
      <iframe
        ref={ref}
        src={src}
        title={title}
        className={`${className ?? ''} ${ARTIFACT_CANVAS}`}
        sandbox={framePolicy('document', src).sandbox}
        allow="fullscreen; clipboard-write"
        referrerPolicy="no-referrer"
        loading={preview ? 'lazy' : 'eager'}
        tabIndex={preview ? -1 : undefined}
        aria-hidden={preview || undefined}
      />
    );
  },
);
