'use client';

import type { ReactNode } from 'react';

/**
 * The one shape every "the viewer can't show this right now" state takes:
 * an icon tile or spinner, a title, optionally the path it concerns,
 * optionally one detail line, optionally one action. `file-content-renderer`
 * used to hand-write this stack five times — the boundary fallback, the
 * waking box, the error skeleton, the not-found box and the binary fallback —
 * with drifted classes between them; those collapse here onto one reading
 * (the waking/not-found pair's: a `font-medium` title, a `/40 max-w-xs`
 * detail line).
 */
export function ViewerNotice({
  media,
  title,
  detail,
  path,
  action,
}: {
  media: ReactNode;
  title: string;
  detail?: string;
  path?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      {media}
      <p className="text-muted-foreground text-sm font-medium">{title}</p>
      {path && (
        <p className="text-muted-foreground/50 max-w-sm font-mono text-xs break-all">{path}</p>
      )}
      {detail && <p className="text-muted-foreground/40 max-w-xs text-xs">{detail}</p>}
      {action}
    </div>
  );
}
