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
  { seg: '/vault', label: 'Vault' },
  { seg: '/assistant', label: 'Assistant' },
  { seg: '/runs', label: 'Runs' },
] as const;

function MatterChrome({ children }: { children: React.ReactNode }) {
  const { matter } = useMatter();
  const path = usePathname();
  const base = `/app/matters/${matter._id}`;
  const update = useMutation(api.matters.update);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="shrink-0 border-b border-border px-6 pt-4">
        <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Link href="/app/matters" className="hover:text-foreground">
            Matters
          </Link>
          <CaretRightIcon className="size-3" />
          <span className="truncate text-foreground">{matter.name}</span>
        </nav>
        <div className="mt-1.5 flex items-center gap-3">
          <h1 className="truncate font-display text-2xl tracking-tight">{matter.name}</h1>
          {matter.number && <span className="font-mono text-xs text-muted-foreground">{matter.number}</span>}
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
        {matter.client && <p className="mt-0.5 text-sm text-muted-foreground">{matter.client}</p>}
        <nav aria-label="Matter" className="mt-3 flex gap-4">
          {TABS.map((t) => {
            const href = `${base}${t.seg}`;
            const active = t.seg === '' ? path === base : path.startsWith(href);
            return (
              <Link
                key={t.seg}
                href={href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  '-mb-px border-b-2 pb-2 text-sm transition-colors',
                  active ? 'border-brand font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
                )}
              >
                {t.label}
              </Link>
            );
          })}
        </nav>
      </header>
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </div>
  );
}
