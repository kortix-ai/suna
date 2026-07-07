'use client';

import { formatDistanceToNowStrict } from 'date-fns';
import { Bell, CheckCheck, CheckCircle2, Inbox as InboxIcon, XCircle } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useMemo, useState } from 'react';

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar';
import { useIsMobile } from '@/hooks/use-mobile';
import {
  useInboxEnabled,
  useMarkInboxRead,
  useProjectInbox,
} from '@/hooks/projects/use-project-inbox';
import type { InboxItem } from '@/lib/inbox-client';
import { cn } from '@/lib/utils';

type Filter = 'all' | 'unread' | 'failed';

function relativeTime(iso: string): string {
  try {
    return formatDistanceToNowStrict(new Date(iso), { addSuffix: false });
  } catch {
    return '';
  }
}

function InboxItemRow({ item, onOpen }: { item: InboxItem; onOpen: (item: InboxItem) => void }) {
  const failed = item.kind === 'run_failed';
  const Icon = failed ? XCircle : CheckCircle2;
  return (
    <button
      type="button"
      onClick={() => onOpen(item)}
      className="group hover:bg-muted/50 focus-visible:bg-muted/50 flex w-full items-start gap-3 px-3.5 py-2.5 text-left transition-colors focus-visible:outline-none"
    >
      <Icon className={cn('mt-0.5 size-4 shrink-0', failed ? 'text-destructive' : 'text-kortix-green')} />
      <div className="min-w-0 flex-1">
        <span className="text-foreground block truncate text-sm leading-5 font-medium">
          {item.title}
        </span>
        <div className="text-muted-foreground mt-0.5 flex items-center gap-1.5 text-xs">
          <span>{failed ? 'Run failed' : 'Run finished'}</span>
          {item.source && <span className="text-muted-foreground/60">· {item.source}</span>}
          <span className="text-muted-foreground/60">· {relativeTime(item.created_at)}</span>
        </div>
      </div>
      {!item.read && <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-red-500" />}
    </button>
  );
}

function FilterTab({
  active,
  count,
  children,
  onClick,
}: {
  active: boolean;
  count?: number;
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition-colors',
        active
          ? 'bg-foreground/10 text-foreground'
          : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {children}
      {count != null && count > 0 && <span className="tabular-nums opacity-60">{count}</span>}
    </button>
  );
}

function NavItemInner({ projectId }: { projectId: string }) {
  const enabled = useInboxEnabled(projectId);
  const isMobile = useIsMobile();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');

  const { data } = useProjectInbox(projectId, enabled);
  const markRead = useMarkInboxRead(projectId);

  const items = useMemo(() => data?.items ?? [], [data?.items]);
  const unreadCount = data?.unread_count ?? 0;
  const failedCount = useMemo(() => items.filter((i) => i.kind === 'run_failed').length, [items]);

  const visible = useMemo(() => {
    if (filter === 'unread') return items.filter((i) => !i.read);
    if (filter === 'failed') return items.filter((i) => i.kind === 'run_failed');
    return items;
  }, [items, filter]);

  const openItem = useCallback(
    (item: InboxItem) => {
      setOpen(false);
      if (item.session_id) {
        markRead.mutate({ session_id: item.session_id });
        router.push(`/projects/${projectId}/sessions/${item.session_id}`);
      } else {
        markRead.mutate({ item_ids: [item.id] });
      }
    },
    [markRead, projectId, router],
  );

  if (!enabled || unreadCount === 0) return null;

  return (
    <SidebarMenuItem>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <SidebarMenuButton className="text-sm! font-medium [&_svg]:size-4!">
            <Bell />
            <span>Inbox</span>
            <span className="ml-auto flex min-w-[1.125rem] items-center justify-center rounded-full bg-destructive/15 px-1.5 text-xs font-medium text-destructive tabular-nums">
              {unreadCount}
            </span>
          </SidebarMenuButton>
        </PopoverTrigger>
        <PopoverContent
          side={isMobile ? 'top' : 'right'}
          align={isMobile ? 'start' : 'end'}
          sideOffset={12}
          className="w-[360px] overflow-hidden p-0"
        >
          <div className="border-border flex items-center justify-between gap-3 border-b px-3.5 py-2.5">
            <div className="flex min-w-0 items-center gap-2.5">
              <span className="bg-kortix-base/10 text-kortix-base grid size-8 shrink-0 place-items-center rounded-md">
                <Bell className="size-4" />
              </span>
              <div className="min-w-0">
                <h3 className="text-foreground truncate text-sm font-medium">Inbox</h3>
                <p className="text-muted-foreground truncate text-xs">
                  {unreadCount} unread from your automations
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => markRead.mutate({ all: true })}
              className="text-muted-foreground hover:text-foreground flex shrink-0 items-center gap-1 text-xs transition-colors"
            >
              <CheckCheck className="size-3.5" />
              Mark all
            </button>
          </div>

          <div className="border-border flex items-center gap-1 border-b px-2.5 py-1.5">
            <FilterTab active={filter === 'all'} count={items.length} onClick={() => setFilter('all')}>
              All
            </FilterTab>
            <FilterTab
              active={filter === 'unread'}
              count={unreadCount}
              onClick={() => setFilter('unread')}
            >
              Unread
            </FilterTab>
            <FilterTab
              active={filter === 'failed'}
              count={failedCount}
              onClick={() => setFilter('failed')}
            >
              Failed
            </FilterTab>
          </div>

          <div className="max-h-[50vh] overflow-y-auto py-1">
            {visible.length === 0 ? (
              <div className="text-muted-foreground/70 flex flex-col items-center gap-2 px-4 py-8 text-center">
                <InboxIcon className="size-5 opacity-50" />
                <span className="text-xs">Nothing here</span>
              </div>
            ) : (
              visible.map((item) => <InboxItemRow key={item.id} item={item} onOpen={openItem} />)
            )}
          </div>
        </PopoverContent>
      </Popover>
    </SidebarMenuItem>
  );
}

export function ProjectInboxNavItem({ projectId }: { projectId: string }) {
  return <NavItemInner projectId={projectId} />;
}
