'use client';

import {
  isLinkSafeHref,
  looksLikeFilePath,
  looksLikeUrl,
} from '@/components/markdown/unified-markdown-utils';
import { useSandboxProxy } from '@/hooks/use-sandbox-proxy';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { useFilePreviewStore } from '@/stores/file-preview-store';
import { getActivePanelSessionId, openFileInSessionPanel } from '@/stores/session-browser-store';
import Link from 'next/link';
import React from 'react';

// ─── Inline code ─────────────────────────────────────────────────────────────
export const INLINE_CODE =
  'rounded-sm border border-[0.5px] bg-muted px-1.5 py-[0.08rem] font-mono text-[0.9rem] text-foreground/95 [overflow-wrap:anywhere] dark:bg-card';

// Inline code that becomes a link (URLs) or opens a file preview (absolute paths).
export function ClickableInlineCode({ children }: { children: React.ReactNode }) {
  const openPreview = useFilePreviewStore((s) => s.openPreview);
  const { proxyUrl } = useSandboxProxy();
  const text = String(children).trim();
  const isUrl = looksLikeUrl(text);
  const isFile = !isUrl && looksLikeFilePath(text);
  const isAbsolute = text.startsWith('/');

  if (isUrl) {
    const href = proxyUrl(text) ?? text;
    const linkClass = cn(INLINE_CODE, 'hover:text-kortix-blue cursor-pointer transition-colors');

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

  if (isFile) {
    const openFile = () => {
      if (!isAbsolute) {
        toast.error(`Cannot open relative path: ${text}`);
        return;
      }
      const sessionId = getActivePanelSessionId();
      if (sessionId) openFileInSessionPanel(sessionId, text);
      else openPreview(text);
    };
    return (
      <code
        role="button"
        onClick={isAbsolute ? openFile : undefined}
        title={isAbsolute ? `Click to preview ${text}` : `${text} — relative path (cannot open)`}
        className={cn(
          INLINE_CODE,
          'transition-colors',
          isAbsolute ? 'hover:text-kortix-blue cursor-pointer' : 'cursor-not-allowed opacity-70',
        )}
      >
        {children}
      </code>
    );
  }

  return <code className={cn(INLINE_CODE, 'text-[0.8rem]')}>{children}</code>;
}
