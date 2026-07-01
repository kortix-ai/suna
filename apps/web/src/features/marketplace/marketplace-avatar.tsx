'use client';

import { useEffect, useState } from 'react';

import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { EntityAvatar, type EntityAvatarSize } from '@/components/ui/entity-avatar';
import { cn } from '@/lib/utils';

type MarketplaceAvatarSize = 'xs' | 'sm' | 'md' | 'lg';

const SIZE_TO_ENTITY: Record<MarketplaceAvatarSize, EntityAvatarSize> = {
  xs: 'xs',
  sm: 'md',
  md: 'lg',
  lg: 'xl',
};

const BOX_CLASS: Record<EntityAvatarSize, string> = {
  xs: 'size-5 rounded-sm',
  sm: 'size-6 rounded-sm',
  md: 'size-8 rounded-md',
  lg: 'size-10 rounded-md',
  xl: 'size-14 rounded-md',
};

const LOGO_PX: Record<MarketplaceAvatarSize, number> = {
  xs: 10,
  sm: 15,
  md: 18,
  lg: 22,
};

const IMG_PX: Record<MarketplaceAvatarSize, number> = {
  xs: 20,
  sm: 32,
  md: 40,
  lg: 56,
};

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
 * Identity tile for a marketplace source, in priority order:
 *   1. the Kortix mark for the official source,
 *   2. the GitHub owner's avatar for an `owner/repo` source,
 *   3. a Google favicon for a URL-hosted registry,
 *   4. a deterministic monogram via EntityAvatar + chalkColors.
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
  size?: MarketplaceAvatarSize;
  className?: string;
}) {
  const entitySize = SIZE_TO_ENTITY[size];
  const boxClass = BOX_CLASS[entitySize];
  const [failed, setFailed] = useState(0);

  // Reset the broken-image fallback when this tile is recycled to a new source.
  useEffect(() => setFailed(0), [id, owner, sourceUrl]);

  if (id === 'kortix') {
    return (
      <div
        className={cn(
          'bg-muted border-border flex shrink-0 items-center justify-center border',
          boxClass,
          className,
        )}
      >
        <KortixLogo variant="symbol" size={LOGO_PX[size]} />
      </div>
    );
  }

  const candidates: string[] = [];
  if (owner) candidates.push(`https://github.com/${owner}.png?size=96`);
  const host = faviconHost(sourceUrl, id);
  if (host) candidates.push(`https://www.google.com/s2/favicons?domain=${host}&sz=64`);

  const src = candidates[failed];
  if (src) {
    const px = IMG_PX[size];
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt=""
        width={px}
        height={px}
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        onError={() => setFailed((f) => f + 1)}
        className={cn(
          'border-border bg-background shrink-0 border object-cover',
          boxClass,
          className,
        )}
      />
    );
  }

  return <EntityAvatar label={label || owner || id} size={entitySize} className={className} />;
}
