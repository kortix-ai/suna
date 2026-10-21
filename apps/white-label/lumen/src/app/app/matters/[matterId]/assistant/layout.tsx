'use client';

import { threadPath, useMatter } from '@/components/access';
import { relativeTime } from '@/lib/utils';
import { api } from '@convex/_generated/api';
import { cn } from '@kortix/ui';
import { Button } from '@kortix/ui/button';
import { ScrollArea } from '@kortix/ui/scroll-area';
import { Skeleton } from '@kortix/ui/skeleton';
import { PlusIcon } from '@phosphor-icons/react';
import { useQuery } from 'convex/react';
import Link from 'next/link';
import { useParams } from 'next/navigation';

/** The matter's Assistant: its threads on the left, the open thread (or a new question) on the right. */
export default function AssistantLayout({ children }: { children: React.ReactNode }) {
  const { matter } = useMatter();
  const activeId = useParams().threadId as string | undefined;
  const threads = useQuery(api.threads.list, { matterId: matter._id });

  return (
    <div className="flex min-h-0 flex-1">
      <aside className="hidden w-64 shrink-0 flex-col border-r border-border md:flex">
        <div className="p-3">
          <Button asChild variant="outline" className="w-full justify-start gap-2 bg-card">
            <Link href={`/app/matters/${matter._id}/assistant`}>
              <PlusIcon className="size-4" /> New chat
            </Link>
          </Button>
        </div>
        <ScrollArea className="flex-1 px-2">
          <ul aria-label="Threads" className="space-y-0.5 pb-3">
            {threads === undefined && Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="mx-1 my-1 h-9 rounded-md" />)}
            {threads?.length === 0 && <p className="px-3 py-6 text-center text-xs text-muted-foreground">No conversations yet.</p>}
            {threads?.map((t) => (
              <li key={t._id}>
                <Link
                  href={threadPath(matter._id, t._id)}
                  className={cn(
                    'block rounded-md px-3 py-2 text-sm transition-colors',
                    t._id === activeId ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                  )}
                >
                  <span className="block truncate">{t.title}</span>
                  <span className="block truncate text-xs text-muted-foreground/70">{relativeTime(new Date(t.lastMessageAt).toISOString())}</span>
                </Link>
              </li>
            ))}
          </ul>
        </ScrollArea>
      </aside>
      <section className="flex min-w-0 flex-1 flex-col">{children}</section>
    </div>
  );
}
