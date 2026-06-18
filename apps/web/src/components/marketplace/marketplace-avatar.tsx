'use client';

import { useEffect, useState } from 'react';

import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { cn } from '@/lib/utils';

const SIZES = {
  xs: { box: 'size-4 rounded', logo: 11, text: 'text-[9px]', px: 16 },
  sm: { box: 'size-8 rounded-lg', logo: 15, text: 'text-xs', px: 32 },
  md: { box: 'size-10 rounded-xl', logo: 18, text: 'text-sm', px: 40 },
  lg: { box: 'size-12 rounded-2xl', logo: 22, text: 'text-base', px: 48 },
} as const;

/** Deterministic hue from a string — every source gets a stable, distinct color. */
function hueOf(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}

/** Favicon host for a non-GitHub source (URL registries get a real brand mark). */
function faviconHost(sourceUrl?: string, id?: string): string | undefined {
  const raw = sourceUrl ?? (id?.includes('://') ? id : undefined);
  if (!raw) return undefined;
  try {
    const host = new URL(raw).hostname;
    return host && host !== 'github.com' ? host : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Identity tile for a marketplace, in priority order:
 *   1. the Kortix mark for the official source,
 *   2. the GitHub owner's avatar for an `owner/repo` source,
 *   3. a Google favicon for a URL-hosted registry,
 *   4. a deterministic colored monogram (hashed hue + initial) — so no two
 *      sources look alike and nothing falls back to the same grey glyph.
 */
export function MarketplaceAvatar({
  id,
  owner,
  sourceUrl,
  label,
  size = 'md',
  className,
}: {
  id: string;
  owner?: string;
  sourceUrl?: string;
  label?: string;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  const s = SIZES[size];
  const [failed, setFailed] = useState(0);
  // Reset the broken-image fallback when this tile is recycled to a new source
  // (React reuses the instance across prop changes → stale monogram otherwise).
  useEffect(() => setFailed(0), [id, owner, sourceUrl]);

  if (id === 'kortix') {
    return (
      <div className={cn('bg-foreground/[0.06] flex shrink-0 items-center justify-center', s.box, className)}>
        <KortixLogo variant="symbol" size={s.logo} />
      </div>
    );
  }

  const candidates: string[] = [];
  if (owner) candidates.push(`https://github.com/${owner}.png?size=96`);
  const host = faviconHost(sourceUrl, id);
  if (host) candidates.push(`https://www.google.com/s2/favicons?domain=${host}&sz=64`);

  const src = candidates[failed];
  if (src) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt=""
        width={s.px}
        height={s.px}
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        onError={() => setFailed((f) => f + 1)}
        className={cn('border-border/60 bg-background shrink-0 border object-cover', s.box, className)}
      />
    );
  }

  // Monogram: hashed-hue tint + initial (light/dark aware via translucent bg).
  const seed = owner || label || id;
  const hue = hueOf(seed);
  const initial = (label || owner || id).replace(/[^a-zA-Z0-9]/g, '').charAt(0).toUpperCase() || '?';
  return (
    <div
      className={cn('flex shrink-0 items-center justify-center font-semibold', s.box, s.text, className)}
      style={{ backgroundColor: `hsl(${hue} 65% 50% / 0.16)`, color: `hsl(${hue} 55% 55%)` }}
      aria-hidden
    >
      {initial}
    </div>
  );
}
