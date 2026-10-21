'use client';

import { MatterGate, useMatter } from '@/components/access';
import { statusVariant } from '@/components/matters/matters-list';
import { STATUS_LABEL } from '@/lib/roles';
import { errorText } from '@/lib/utils';
import { api } from '@convex/_generated/api';
import { cn } from '@kortix/ui';
import { Badge } from '@kortix/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@kortix/ui/dropdown-menu';
import { errorToast } from '@kortix/ui/toast';
import { CaretDownIcon, CaretRightIcon, LockSimpleIcon } from '@phosphor-icons/react';
import { useMutation } from 'convex/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams, usePathname } from 'next/navigation';

export default function MatterLayout({ children }: { children: React.ReactNode }) {
  const matterId = String(useParams().matterId);
  return (
    <MatterGate matterId={matterId}>
      <MatterChrome>{children}</MatterChrome>
    </MatterGate>
  );
}

const TABS = [
  { seg: '', label: 'Overview' },
  { seg: '/vault', label: 'Documents' },
  { seg: '/assistant', label: 'Chats' },
  { seg: '/reviews', label: 'Tabular reviews' },
  { seg: '/workflows', label: 'Workflows' },
  { seg: '/history', label: 'History' },
] as const;

function MatterChrome({ children }: { children: React.ReactNode }) {
  const { matter } = useMatter();
  const path = usePathname();
  const base = `/app/matters/${matter._id}`;
  // In a thread on a phone, the header shrinks to the title and the tabs: the conversation gets the height.
  const inThread = /^\/assistant\/[^/]+/.test(path.slice(base.length));
  const update = useMutation(api.matters.update);
  // The active tab is always in view on a phone, and a fade marks tabs past the right edge.
  const tabs = useRef<HTMLElement>(null);
  const [more, setMore] = useState(false);
  const edge = useCallback(() => {
    const el = tabs.current;
    if (el) setMore(el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
  }, []);
  useEffect(() => {
    tabs.current?.querySelector('[aria-current="page"]')?.scrollIntoView({ inline: 'center', block: 'nearest' });
    edge();
  }, [path, edge]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="shrink-0 border-b border-border">
        <div className={cn('mx-auto w-full max-w-6xl px-4 pt-4 sm:px-6', inThread && 'max-sm:pt-2')}>
        <nav aria-label="Breadcrumb" className={cn('flex items-center gap-1.5 text-xs text-muted-foreground', inThread && 'max-sm:hidden')}>
          <Link href="/app/matters" className="hover:text-foreground">
            Matters
          </Link>
          <CaretRightIcon className="size-3" />
          <span className="truncate text-foreground">{matter.name}</span>
        </nav>
        <div className={cn('mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1', inThread && 'max-sm:mt-0 max-sm:flex-nowrap')}>
          <h1 className={cn('min-w-0 truncate font-display text-[28px] leading-tight font-[380] tracking-[-0.03em]', inThread && 'max-sm:text-[19px]')}>{matter.name}</h1>
          {matter.number && <span className={cn('font-mono text-xs text-muted-foreground', inThread && 'max-sm:hidden')}>{matter.number}</span>}
          {matter.visibility === 'restricted' && (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <LockSimpleIcon className="size-3.5" /> Restricted
            </span>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger aria-label="Matter status" className="flex items-center gap-1 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <Badge variant={statusVariant(matter.status)}>{STATUS_LABEL[matter.status]}</Badge>
              <CaretDownIcon className="size-3 text-muted-foreground" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-36">
              <DropdownMenuRadioGroup
                value={matter.status}
                onValueChange={(status) =>
                  update({ matterId: matter._id, status: status as 'open' | 'on_hold' | 'closed' }).catch((err) =>
                    errorToast('Could not change the status', { description: errorText(err) }),
                  )
                }
              >
                <DropdownMenuRadioItem value="open">Open</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="on_hold">On hold</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="closed">Closed</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        {matter.client && <p className={cn('mt-0.5 text-sm text-muted-foreground', inThread && 'max-sm:hidden')}>{matter.client}</p>}
        <nav
          ref={tabs}
          onScroll={edge}
          aria-label="Matter"
          className={cn(
            'scrollbar-none -mx-4 mt-3 flex gap-4 overflow-x-auto px-4 sm:mx-0 sm:px-0',
            inThread && 'max-sm:mt-1.5',
            // More tabs to the right than fit (390 px): fade the edge so the strip reads as scrollable.
            more && '[mask-image:linear-gradient(to_right,black_80%,transparent)]',
          )}
        >
          {TABS.map((t) => {
            const href = `${base}${t.seg}`;
            // A run's detail page belongs to History.
            const active = t.seg === '' ? path === base : path.startsWith(href) || (t.seg === '/history' && path.startsWith(`${base}/runs`));
            return (
              <Link
                key={t.seg}
                href={href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  '-mb-px shrink-0 border-b-2 pb-2 text-sm transition-colors',
                  active ? 'border-brand font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
                )}
              >
                {t.label}
              </Link>
            );
          })}
        </nav>
        </div>
      </header>
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </div>
  );
}
