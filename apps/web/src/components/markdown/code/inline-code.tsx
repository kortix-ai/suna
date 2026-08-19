'use client';

import {
  isLinkSafeHref,
  looksLikeFilePath,
  looksLikeUrl,
} from '@/components/markdown/unified-markdown-utils';
import {
  peekFileAvailability,
  probeFileAvailability,
  type FileAvailability,
} from '@/features/session/file-availability';
import { resolveRuntimePath } from '@/features/session/use-oc-file-open';
import { useSandboxProxy } from '@/hooks/use-sandbox-proxy';
import { cn } from '@/lib/utils';
import { useFilePreviewStore } from '@/stores/file-preview-store';
import { useSessionBrowserStore } from '@/stores/session-browser-store';
import Link from 'next/link';
import React, { useCallback, useEffect, useRef, useState } from 'react';

// ─── Inline code ─────────────────────────────────────────────────────────────
export const INLINE_CODE =
  'rounded-[5px] bg-muted px-1.5 py-[0.08rem] font-mono text-[0.9rem] text-foreground/95 [overflow-wrap:anywhere] dark:bg-card border border-muted-foreground/5';

/**
 * A path inside a message, rendered as a door to the file — but only while
 * the file is behind it.
 *
 * The affordance used to be inferred from the SHAPE of the string alone
 * (`looksLikeFilePath` + a leading slash). That is a claim about syntax, not
 * about the sandbox, and a transcript is a record of what HAPPENED rather than
 * a description of what exists now: the row announcing that
 * `/workspace/build_comp_xlsx.py` was deleted still painted it hover-blue and
 * `role="button"`, and clicking it dead-ended on "This file couldn't be
 * opened". A door that opens onto a wall is worse than no door.
 *
 * Two fixes, both about the path being real:
 *
 *   - **Resolve before opening.** The panel takes project-relative paths — it
 *     is what `useOcFileOpen` hands it everywhere else — and this span was
 *     passing the raw `/workspace/…` string straight through, so some paths
 *     failed to open even when the file was sitting right there. Both callers
 *     now share `resolveRuntimePath`.
 *   - **Ask before offering.** Availability is probed on hover/focus and
 *     cached per path (see `file-availability.ts`); a path the runtime cannot
 *     produce loses its affordance instead of keeping it and failing late.
 *
 * Relative paths are openable too, and now say so. They were rendered
 * `cursor-not-allowed` with a `role="button"` that did nothing — an element
 * announcing itself to a screen reader as a button while being wired to
 * `undefined`. The panel has always accepted the relative form; that is the
 * form it is given.
 */
function FilePathCode({ text, children }: { text: string; children: React.ReactNode }) {
  const openPreview = useFilePreviewStore((s) => s.openPreview);
  // Reactive: a path rendered before the session mounts must become probeable
  // once it does, without waiting for the message to re-render for other
  // reasons.
  const sessionId = useSessionBrowserStore((s) => s.activeSessionId);
  const [status, setStatus] = useState<FileAvailability>(() => peekFileAvailability(text));

  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // Only a live session has a runtime to ask. On the dashboard and project
  // pages the target is the preview modal and there is nothing to probe — so
  // stay optimistic there rather than condemning every path on a network
  // error that says nothing about the file.
  const canProbe = Boolean(sessionId);
  const missing = status === 'missing';

  // Pointer/keyboard intent, not render. A message with forty paths in it
  // issues zero requests until the reader reaches for one.
  const probe = useCallback(() => {
    if (!canProbe || peekFileAvailability(text) !== 'unknown') return;
    void probeFileAvailability(text).then((verdict) => {
      if (alive.current) setStatus(verdict);
    });
  }, [canProbe, text]);

  const open = useCallback(async () => {
    if (missing) return;
    // Covers the fast click that beat the hover probe home.
    if (canProbe) {
      const verdict = await probeFileAvailability(text);
      if (verdict === 'missing') {
        if (alive.current) setStatus('missing');
        return;
      }
    }
    openPreview(await resolveRuntimePath(text));
  }, [canProbe, missing, openPreview, text]);

  if (missing) {
    // Inert: no `role`, no handler, no pointer. The demotion to
    // `text-muted-foreground` is the whole visual signal — deliberately not a
    // strikethrough, because a probe failure cannot tell a deleted file apart
    // from a sandbox that stopped answering, and only one of those means the
    // file is gone.
    return (
      <code
        title={`${text} — not available in this session`}
        className={cn(INLINE_CODE, 'text-muted-foreground')}
      >
        {children}
      </code>
    );
  }

  return (
    <code
      role="button"
      tabIndex={0}
      title={`Click to preview ${text}`}
      onPointerEnter={probe}
      onFocus={probe}
      onClick={() => void open()}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          void open();
        }
      }}
      className={cn(
        INLINE_CODE,
        'hover:text-foreground cursor-pointer transition-colors',
        'focus-visible:ring-ring rounded-sm focus-visible:ring-2 focus-visible:outline-none',
      )}
    >
      {children}
    </code>
  );
}

// Inline code that becomes a link (URLs) or opens a file preview (paths).
export function ClickableInlineCode({ children }: { children: React.ReactNode }) {
  const { proxyUrl } = useSandboxProxy();
  const text = String(children).trim();
  const isUrl = looksLikeUrl(text);

  if (isUrl) {
    const href = proxyUrl(text) ?? text;
    const linkClass = cn(INLINE_CODE, 'hover:text-foreground cursor-pointer transition-colors');

    // A malformed absolute URL (e.g. `http://:`) must not reach next/link —
    // its prefetch path throws `Cannot prefetch '...'` (see isLinkSafeHref).
    if (!isLinkSafeHref(href)) {
      return (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          title={`Open ${text} in a new tab`}
          className={linkClass}
        >
          {children}
        </a>
      );
    }

    return (
      <Link
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        title={`Open ${text} in a new tab`}
        className={linkClass}
      >
        {children}
      </Link>
    );
  }

  if (looksLikeFilePath(text)) {
    return <FilePathCode text={text}>{children}</FilePathCode>;
  }

  return <code className={cn(INLINE_CODE, 'text-[0.8rem]')}>{children}</code>;
}
