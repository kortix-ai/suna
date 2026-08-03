'use client';

import { FaviconAvatar } from '@/components/ui/favicon-avatar';
import { wsDomain } from '@/features/session/tool/shared/web-helpers';
import { safeHttpUrl } from '@/lib/safe-url';
import { cn } from '@/lib/utils';

/**
 * One web source, flat: favicon → title → domain. The single row shape every
 * source list shares, so a source looks the same wherever it appears.
 * Unsafe/relative URLs render as a plain row instead of a link — never an href
 * we can't vouch for.
 *
 * Radius is 4px, not a token: the row sits inside a `rounded-md` (8px) card
 * with `p-1` (4px), and concentric radius wants inner = outer − padding.
 * `rounded-sm` is 6px here, which would bulge against the card's corner.
 */
const ROW_CLASS = 'flex items-center gap-2.5 rounded-sm px-2 py-2';

export function WebSourceRow({ url, title }: { url: string; title: string }) {
  const safe = safeHttpUrl(url);
  const domain = safe ? wsDomain(safe) : '';
  const inner = (
    <>
      <FaviconAvatar value={safe ?? title} size="xs" className="shrink-0" />
      <span className="text-foreground min-w-0 flex-1 truncate text-sm">{title}</span>
      {domain && (
        <span className="text-muted-foreground max-w-[40%] shrink-0 truncate text-sm">
          {domain}
        </span>
      )}
    </>
  );

  if (!safe) {
    return (
      <div data-component="web-source-row" className={ROW_CLASS}>
        {inner}
      </div>
    );
  }
  return (
    <a
      href={safe}
      target="_blank"
      rel="noopener noreferrer"
      data-component="web-source-row"
      className={cn(ROW_CLASS, 'hover:bg-muted transition-colors duration-150')}
    >
      {inner}
    </a>
  );
}
