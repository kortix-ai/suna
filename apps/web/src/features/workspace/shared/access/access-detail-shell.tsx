'use client';

// AccessDetailShell — ONE drill-down shell for the three access detail
// surfaces: a group (`/accounts/[id]/groups/[groupId]`), a member
// (`/accounts/[id]/members/[userId]`), and the project panel
// (`?tab=access-projects&project=<id>`). The routes stay where they are;
// only the chrome is shared.
//
// Header geometry is the group detail page's (`groups/[groupId]/page.tsx:
// 163-201`); the title/description typography matches the hub's
// `PANE_META` header (`accounts/[id]/page.tsx:540-545`) so a detail page
// and a hub pane read as the same surface.

import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import { CaretLeftIcon } from '@phosphor-icons/react';
import Link from 'next/link';
import type { ReactNode } from 'react';

export interface AccessDetailTab {
  value: string;
  label: string;
  /** Optional count badge inside the trigger. */
  badge?: ReactNode;
}

export interface AccessDetailShellProps {
  /** "‹ {label}" breadcrumb. Give it an `href` or an `onClick`, not both. */
  back: { label: string; href?: string; onClick?: () => void };
  /** `UserAvatar size="lg"` / `EntityAvatar size="lg"`. */
  avatar?: ReactNode;
  title: ReactNode;
  badges?: ReactNode;
  /** One muted line under the title — description, counts, "Joined …". */
  meta?: ReactNode;
  /** Right of the header: an "Open project" link, a kebab, a primary action. */
  actions?: ReactNode;
  tabs?: AccessDetailTab[];
  activeTab?: string;
  onTabChange?: (value: string) => void;
  /** Skeletons the avatar + title while the entity loads. */
  loading?: boolean;
  /** Stacked `AccessList` sections. */
  children: ReactNode;
  className?: string;
}

export function AccessDetailShell({
  back,
  avatar,
  title,
  badges,
  meta,
  actions,
  tabs,
  activeTab,
  onTabChange,
  loading = false,
  children,
  className,
}: AccessDetailShellProps) {
  const backContent = (
    <>
      <CaretLeftIcon className="size-4" />
      {back.label}
    </>
  );
  const backClass =
    'text-muted-foreground hover:text-foreground flex w-fit items-center gap-1 text-sm transition-colors';

  return (
    <div className={cn('mx-auto w-full max-w-6xl space-y-5 pb-10', className)}>
      <div className="space-y-5">
        {back.href ? (
          <Link href={back.href} className={backClass}>
            {backContent}
          </Link>
        ) : (
          <button type="button" onClick={back.onClick} className={backClass}>
            {backContent}
          </button>
        )}

        <div className="flex min-w-0 items-start gap-3.5">
          {loading ? <Skeleton className="size-10 rounded-md" /> : avatar}
          <div className="min-w-0 flex-1 space-y-0.5">
            {loading ? (
              <Skeleton className="h-6 w-44" />
            ) : (
              <div className="flex min-w-0 items-center gap-2">
                <h2 className="text-foreground truncate text-xl font-medium">{title}</h2>
                {badges}
              </div>
            )}
            {/* `div`, not `p`: callers pass `InlineMeta`, which renders a `div`.
                A `div` inside a `p` is invalid HTML and hydrates as an error. */}
            {meta ? <div className="text-muted-foreground truncate text-sm">{meta}</div> : null}
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
        </div>
      </div>

      {tabs && tabs.length > 0 ? (
        <Tabs value={activeTab} onValueChange={onTabChange} className="space-y-6">
          <TabsList type="underline" className="flex w-full items-center justify-start">
            {tabs.map((tab) => (
              <TabsTrigger key={tab.value} value={tab.value} className="w-fit flex-none">
                {tab.label}
                {tab.badge}
              </TabsTrigger>
            ))}
          </TabsList>
          {children}
        </Tabs>
      ) : (
        <div className="space-y-6">{children}</div>
      )}
    </div>
  );
}
