'use client';

/**
 * Project view — single-sandbox combined page.
 *
 * The user-facing entry is labelled "Project view" (one Tauri tab). Inside,
 * the user switches between Board / Milestones / Team via inline underline
 * tabs in a single h-11 header row — same visual language as the old
 * /projects/[id] page header (ProjectHeader). No nested pill bars, no
 * centered duplicate strips.
 *
 * The sandbox owns one implicit project (proj-workspace, auto-bootstrapped
 * by the kortix-system plugin when KORTIX_PROJECTS_ENABLED=true). All three
 * tabs operate against that single project.
 *
 * Triggers + Channels + Credentials + Files + Sessions are sandbox-wide and
 * live in their own top-level entries — they're NOT inside this view.
 *
 * Gated by `featureFlags.enableProjects` — when off, redirects to
 * /workspace.
 */

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import { Loader2, Plus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { featureFlags } from '@/lib/feature-flags';
import {
  useTickets,
  useColumns,
  useProjectAgents,
  useFields,
  useUpdateTicketStatus,
  useDeleteTicket,
  type Ticket,
} from '@/hooks/kortix/use-kortix-tickets';
import { TicketBoard } from '@/components/kortix/ticket-board';
import { NewTicketDialog } from '@/components/kortix/new-ticket-dialog';
import { TicketDetailDrawer } from '@/components/kortix/ticket-detail-drawer';
import { MilestonesTab } from '@/components/kortix/milestones-tab';
import { TeamTab } from '@/components/kortix/team-tab';

const PROJECT_ID = 'proj-workspace';

type Tab = 'board' | 'milestones' | 'team';

const TABS: { id: Tab; label: string }[] = [
  { id: 'board', label: 'Board' },
  { id: 'milestones', label: 'Milestones' },
  { id: 'team', label: 'Team' },
];

function BoardRedirect() {
  const router = useRouter();
  useEffect(() => { router.replace('/workspace'); }, [router]);
  return (
    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
      Redirecting to workspace…
    </div>
  );
}

export default function ProjectViewPage() {
  if (!featureFlags.enableProjects) return <BoardRedirect />;
  return <ProjectViewInner />;
}

function ProjectViewInner() {
  const [tab, setTab] = useState<Tab>('board');
  const [newTicketOpen, setNewTicketOpen] = useState(false);
  const [newTicketDefaultStatus, setNewTicketDefaultStatus] = useState<string | undefined>();

  // Hoisted into the page so the New-ticket button in the header can open
  // the dialog regardless of which inner tab is active.
  const { data: columns = [] } = useColumns(PROJECT_ID);

  const openNewTicket = useCallback((status?: string) => {
    setNewTicketDefaultStatus(status);
    setNewTicketOpen(true);
  }, []);

  return (
    <div className="flex h-full flex-col">
      {/* Single header row — underline tabs left, action button right.
          Same visual language as the old /projects/[id]:ProjectHeader so
          users moving from the legacy multi-project URL feel at home. */}
      <header className="shrink-0 border-b border-border/60 bg-background">
        <div className="container mx-auto max-w-7xl h-11 px-3 sm:px-4">
          <TabsPrimitive.Root
            value={tab}
            onValueChange={(v) => setTab(v as Tab)}
            className="h-full flex items-center gap-4"
          >
            <TabsPrimitive.List className="flex items-center h-full gap-5 shrink-0">
              {TABS.map((t) => (
                <TabsPrimitive.Trigger
                  key={t.id}
                  value={t.id}
                  className={cn(
                    'relative h-full inline-flex items-center text-[13px] font-medium tracking-tight cursor-pointer transition-colors outline-none',
                    'text-muted-foreground/60 hover:text-foreground',
                    'data-[state=active]:text-foreground',
                    'after:absolute after:inset-x-0 after:bottom-0 after:h-[2px] after:bg-foreground after:rounded-full',
                    'after:opacity-0 data-[state=active]:after:opacity-100 after:transition-opacity',
                  )}
                >
                  {t.label}
                </TabsPrimitive.Trigger>
              ))}
            </TabsPrimitive.List>

            <div className="flex-1 flex items-center justify-end gap-1.5">
              {tab === 'board' && (
                <Button
                  size="sm"
                  onClick={() => openNewTicket()}
                  title="New ticket (C)"
                  className="h-7 px-2.5 text-[12px] gap-1.5"
                >
                  <Plus className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">New ticket</span>
                  <kbd className="hidden sm:inline-flex items-center justify-center min-w-[18px] h-4 px-1 rounded border border-primary-foreground/20 bg-primary-foreground/10 text-[10px] font-mono font-medium leading-none text-primary-foreground/90">
                    C
                  </kbd>
                </Button>
              )}
            </div>
          </TabsPrimitive.Root>
        </div>
      </header>

      {/* Body — TabPanel pattern: render all tabs, hide inactive via CSS so
          internal state (search, filters, scroll position) survives switches. */}
      <div className="flex-1 min-h-0 relative">
        <TabPanel active={tab === 'board'}>
          <BoardTabPanel
            columns={columns}
            onNewTicket={openNewTicket}
          />
        </TabPanel>
        <TabPanel active={tab === 'milestones'}>
          <MilestonesTab projectId={PROJECT_ID} />
        </TabPanel>
        <TabPanel active={tab === 'team'}>
          <TeamTab projectId={PROJECT_ID} />
        </TabPanel>
      </div>

      <NewTicketDialog
        open={newTicketOpen}
        onOpenChange={setNewTicketOpen}
        projectId={PROJECT_ID}
        columns={columns}
        defaultStatus={newTicketDefaultStatus}
      />
    </div>
  );
}

function TabPanel({ active, children }: { active: boolean; children: React.ReactNode }) {
  return (
    <div className={cn('absolute inset-0 flex flex-col overflow-hidden', !active && 'hidden')}>
      {children}
    </div>
  );
}

function BoardTabPanel({
  columns,
  onNewTicket,
}: {
  columns: ReturnType<typeof useColumns>['data'] extends infer T ? T : never;
  onNewTicket: (status?: string) => void;
}) {
  const { data: tickets = [], isLoading } = useTickets(PROJECT_ID, { enabled: true });
  const { data: agents = [] } = useProjectAgents(PROJECT_ID);
  const { data: fields = [] } = useFields(PROJECT_ID);

  const updateTicketStatus = useUpdateTicketStatus();
  const deleteTicket = useDeleteTicket();

  const [openTicketId, setOpenTicketId] = useState<string | null>(null);
  const openTicket = useCallback((t: Ticket) => setOpenTicketId(t.id), []);
  const closeTicket = useCallback(() => setOpenTicketId(null), []);

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <TicketBoard
        tickets={tickets}
        columns={columns ?? []}
        agents={agents}
        onOpenTicket={openTicket}
        onNewTicket={onNewTicket}
        onUpdateStatus={(id, status) => updateTicketStatus.mutate({ id, status })}
        onDeleteTicket={(id) => deleteTicket.mutate(id)}
      />
      <TicketDetailDrawer
        ticketId={openTicketId}
        onClose={closeTicket}
        columns={columns ?? []}
        fields={fields}
        agents={agents}
        pollingEnabled={!!openTicketId}
      />
    </div>
  );
}
