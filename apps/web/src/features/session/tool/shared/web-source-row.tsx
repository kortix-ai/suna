'use client';

import { FaviconAvatar } from '@/components/ui/favicon-avatar';
import { wsDomain } from '@/features/session/tool/shared/web-helpers';
import { safeHttpUrl } from '@/lib/safe-url';

/**
 * One web source, flat: favicon → title → domain. The single row shape every
 * source list shares (web-search results, the context card's "Web sources")
 * so a source looks the same wherever it appears. Unsafe/relative URLs
 * render as a plain row instead of a link — never an href we can't vouch for.
 */
export function WebSourceRow({ url, title }: { url: string; title: string }) {
  const safe = safeHttpUrl(url);
  const domain = safe ? wsDomain(safe) : '';
  const inner = (
    <>
      <FaviconAvatar value={safe ?? title} size="xs" className="shrink-0" />
      <span className="text-foreground min-w-0 flex-1 truncate text-sm">{title}</span>
      {domain && (
        <span className="text-muted-foreground max-w-[45%] shrink-0 truncate text-xs">
          {domain}
        </span>
      )}
    </>
  );

  if (!safe) {
    return <div className="flex items-center gap-2 rounded-sm px-2 py-1.5">{inner}</div>;
  }
  return (
    <a
      href={safe}
      target="_blank"
      rel="noopener noreferrer"
      className="hover:bg-muted flex items-center gap-2 rounded-sm px-2 py-1.5 transition-colors active:scale-[0.99]"
    >
      {inner}
    </a>
  );
}
