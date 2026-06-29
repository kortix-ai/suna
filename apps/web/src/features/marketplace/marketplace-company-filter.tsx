'use client';

import Link from 'next/link';

import { MarketplaceAvatar } from '@/features/marketplace/marketplace-avatar';
import type { MarketplaceSummary } from '@/lib/marketplace-client';
import { companySlugFromId, marketplaceCompanyHref } from '@/lib/marketplace-slug';
import { cn } from '@/lib/utils';

export function MarketplaceCompanyFilter({
  marketplaces,
  activeId,
  className,
}: {
  marketplaces: MarketplaceSummary[];
  /** `all` for the unfiltered catalog, otherwise a marketplace id. */
  activeId: string;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-wrap gap-2', className)}>
      <CompanyChip href="/marketplace" label="All sources" active={activeId === 'all'} />
      {marketplaces.map((m) => (
        <CompanyChip
          key={m.id}
          href={marketplaceCompanyHref(m.id)}
          label={displayCompanyLabel(m.id, m.label)}
          active={activeId === m.id}
          avatar={
            <MarketplaceAvatar
              id={m.id}
              owner={m.owner}
              sourceUrl={m.sourceUrl}
              label={m.label}
              size="xs"
            />
          }
        />
      ))}
    </div>
  );
}

function CompanyChip({
  href,
  label,
  active,
  avatar,
}: {
  href: string;
  label: string;
  active: boolean;
  avatar?: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'inline-flex max-w-full items-center gap-2 rounded-md border px-3 py-1.5 text-sm',
        'transition-[background-color,color,transform] active:scale-[0.96]',
        active
          ? 'border-foreground/15 bg-primary/[0.06] text-foreground font-medium'
          : 'border-border bg-popover text-muted-foreground hover:text-foreground hover:bg-muted/40',
      )}
    >
      {avatar}
      <span className="truncate">{label}</span>
    </Link>
  );
}

const KNOWN_COMPANY_LABELS: Record<string, string> = {
  kortix: 'Kortix',
  'anthropics/skills': 'Anthropic Skills',
  'anthropics/knowledge-work-plugins': 'Anthropic Knowledge Work',
};

export function displayCompanyLabel(marketplaceId: string, label?: string): string {
  if (label && label !== marketplaceId) return label;
  return KNOWN_COMPANY_LABELS[marketplaceId] ?? marketplaceId;
}
export function marketplaceIdFromCompanySlug(
  slug: string,
  marketplaces: MarketplaceSummary[],
): string | null {
  const id = slug
    .split('--')
    .map((part) => decodeURIComponent(part))
    .join('/');
  return marketplaces.some((m) => m.id === id) ? id : null;
}

export function companySlugMatchesId(slug: string, marketplaceId: string): boolean {
  return companySlugFromId(marketplaceId) === slug;
}
