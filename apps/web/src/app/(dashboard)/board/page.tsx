'use client';

/**
 * Global board page — single-project paradigm.
 *
 * The sandbox is one implicit project (proj-workspace, auto-bootstrapped by
 * the kortix-system plugin when KORTIX_PROJECTS_ENABLED=true). Tickets,
 * columns, milestones live under that project sandbox-wide; this page
 * surfaces them as a global kanban without a per-project URL.
 *
 * Gated by `featureFlags.enableMultiProject` — when off, we redirect to
 * /workspace so the route is unreachable in default mode. The legacy
 * /projects/[id] route stays in place for direct navigation but is no
 * longer linked from any UI.
 */

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { redirect } from 'next/navigation';
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
  // Build-time gate. The flag is a const, so the unused branch tree-shakes
  // and the rules-of-hooks invariant holds.
  if (!featureFlags.enableMultiProject) return <BoardRedirect />;
  return <BoardPageInner />;
}

function BoardPageInner() {
  const { data: tickets = [], isLoading: ticketsLoading } = useTickets(PROJECT_ID, {
    enabled: true,
  });
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
