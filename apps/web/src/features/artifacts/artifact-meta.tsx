'use client';

import type { ArtifactType, ArtifactVisibility } from '@kortix/sdk';
import { BrowserIcon, FileTextIcon, GlobeSimpleIcon, LockSimpleIcon, UsersThreeIcon, type Icon } from '@phosphor-icons/react';
import { forwardRef } from 'react';

import { ARTIFACT_FRAME_ALLOW, ARTIFACT_IFRAME_SANDBOX } from './frame-sandbox';

export const ARTIFACT_TYPE_ICON: Record<ArtifactType, Icon> = {
  doc: FileTextIcon,
  html: BrowserIcon,
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

/** An artifact page, sandboxed by the content server and by this iframe. */
export const ArtifactFrame = forwardRef<HTMLIFrameElement, { src: string; title: string; className?: string; preview?: boolean }>(
  function ArtifactFrame({ src, title, className, preview }, ref) {
    return (
      <iframe
        ref={ref}
        src={src}
        title={title}
        className={`${className ?? ''} ${ARTIFACT_CANVAS}`}
        sandbox={ARTIFACT_IFRAME_SANDBOX}
        allow={ARTIFACT_FRAME_ALLOW}
        referrerPolicy="no-referrer"
        loading={preview ? 'lazy' : 'eager'}
        // The viewer hands the keyboard to the page, so a deck's arrow keys work at once.
        onLoad={preview ? undefined : (e) => e.currentTarget.contentWindow?.focus()}
        tabIndex={preview ? -1 : undefined}
        aria-hidden={preview || undefined}
      />
    );
  },
);
