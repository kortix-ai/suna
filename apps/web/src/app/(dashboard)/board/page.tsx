'use client';

/**
 * Global project page — single-sandbox paradigm.
 *
 * The sandbox owns one implicit project (proj-workspace, auto-bootstrapped
 * by the kortix-system plugin when KORTIX_PROJECTS_ENABLED=true). This page
 * surfaces every project-paradigm surface (board, milestones, team,
 * credentials) under a single global URL — no projectId in the path, no
 * per-project nesting.
 *
 * Triggers + Channels are deliberately NOT here — those are sandbox-wide
 * surfaces (live at /triggers, /channels) and don't belong inside the
 * project view. Files + Sessions are also sandbox-wide and live at /files,
 * /sessions.
 *
 * Gated by `featureFlags.enableProjects` — when off, redirects to
 * /workspace so the route is unreachable in default mode.
 */

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, LayoutGrid, Flag, Users, KeyRound } from 'lucide-react';
import { useEffect } from 'react';
import { cn } from '@/lib/utils';
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
import { CredentialsTab } from '@/components/kortix/credentials-tab';

const PROJECT_ID = 'proj-workspace';

type Tab = 'board' | 'milestones' | 'team' | 'credentials';

const TABS: { id: Tab; label: string; icon: typeof LayoutGrid }[] = [
  { id: 'board', label: 'Board', icon: LayoutGrid },
  { id: 'milestones', label: 'Milestones', icon: Flag },
  { id: 'team', label: 'Team', icon: Users },
  { id: 'credentials', label: 'Credentials', icon: KeyRound },
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

export default function BoardPage() {
  // Build-time gate. The flag is a const, so the unused branch tree-shakes
  // and the rules-of-hooks invariant holds.
  if (!featureFlags.enableProjects) return <BoardRedirect />;
  return <BoardPageInner />;
}

function BoardPageInner() {
  const [tab, setTab] = useState<Tab>('board');

  return (
    <div className="flex h-full flex-col">
      {/* Pill-style tab bar — matches /projects/[id]'s sub-nav visual language. */}
      <div className="shrink-0 border-b border-border/40 bg-background/95 backdrop-blur">
        <div className="container mx-auto max-w-3xl px-3 sm:px-4 py-2.5 flex items-center gap-1">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={cn(
                'inline-flex items-center gap-1.5 px-3 h-8 text-xs font-medium rounded-full transition-colors cursor-pointer',
                tab === id
                  ? 'bg-foreground/10 text-foreground'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted/40',
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-hidden">
        {tab === 'board' && <BoardTabPanel />}
        {tab === 'milestones' && <MilestonesTab projectId={PROJECT_ID} />}
        {tab === 'team' && <TeamTab projectId={PROJECT_ID} />}
        {tab === 'credentials' && <CredentialsTab projectId={PROJECT_ID} />}
      </div>
    </div>
  );
}

function BoardTabPanel() {
  const { data: tickets = [], isLoading: ticketsLoading } = useTickets(PROJECT_ID, { enabled: true });
  const { data: columns = [] } = useColumns(PROJECT_ID);
  const { data: agents = [] } = useProjectAgents(PROJECT_ID);
  const { data: fields = [] } = useFields(PROJECT_ID);

  const updateTicketStatus = useUpdateTicketStatus();
  const deleteTicket = useDeleteTicket();

  const [newTicketOpen, setNewTicketOpen] = useState(false);
  const [newTicketDefaultStatus, setNewTicketDefaultStatus] = useState<string | undefined>();
  const [openTicketId, setOpenTicketId] = useState<string | null>(null);

  const openTicket = useCallback((t: Ticket) => setOpenTicketId(t.id), []);
  const closeTicket = useCallback(() => setOpenTicketId(null), []);
  const openNewTicket = useCallback((status?: string) => {
    setNewTicketDefaultStatus(status);
    setNewTicketOpen(true);
  }, []);

  if (ticketsLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 min-h-0">
        <TicketBoard
          tickets={tickets}
          columns={columns}
          agents={agents}
          onOpenTicket={openTicket}
          onNewTicket={openNewTicket}
          onUpdateStatus={(id, status) => updateTicketStatus.mutate({ id, status })}
          onDeleteTicket={(id) => deleteTicket.mutate(id)}
        />
      </div>

      <NewTicketDialog
        open={newTicketOpen}
        onOpenChange={setNewTicketOpen}
        projectId={PROJECT_ID}
        columns={columns}
        defaultStatus={newTicketDefaultStatus}
      />
      <TicketDetailDrawer
        ticketId={openTicketId}
        onClose={closeTicket}
        columns={columns}
        fields={fields}
        agents={agents}
        pollingEnabled={!!openTicketId}
      />
    </div>
  );
}
