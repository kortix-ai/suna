'use client';

/**
 * Global board page — single-sandbox kanban.
 *
 * Renders the kanban for `proj-workspace` (auto-bootstrapped). Pure board
 * surface — milestones live at /milestones, team at /team, credentials are
 * sandbox-wide at /settings/credentials. No inner tab strip.
 *
 * Gated by `featureFlags.enableProjects` — when off, redirects to
 * /workspace so the route is unreachable in default mode.
 */

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
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

const PROJECT_ID = 'proj-workspace';

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
  if (!featureFlags.enableProjects) return <BoardRedirect />;
  return <BoardPageInner />;
}

function BoardPageInner() {
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
