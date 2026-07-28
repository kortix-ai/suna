'use client';

/**
 * Who inherits this agent — the members/groups assigned to it (Members →
 * Resource access). Each inherits the agent's declared secrets & connectors as
 * their own. Manager-only data: gated on a LIVE can_manage capability so it never
 * fires the manager-only grants endpoint (no 403 / error toast) and never renders
 * stale cached assignments to someone whose manager role was just revoked.
 *
 * Rendered inside the detail pane's single "Advanced" disclosure.
 */

import { Badge } from '@/components/ui/badge';
import { listProjectAccess, listProjectResourceGrants } from '@kortix/sdk';
import { useQuery } from '@tanstack/react-query';
import { User, Users } from 'lucide-react';

export function AgentAssignments({
  projectId,
  agentName,
}: {
  projectId: string;
  agentName: string;
}) {
  const accessQuery = useQuery({
    queryKey: ['project-access', projectId],
    queryFn: () => listProjectAccess(projectId),
    staleTime: 20_000,
  });
  const canManage = Boolean(accessQuery.data?.can_manage);
  const grantsQuery = useQuery({
    queryKey: ['project-resource-grants', projectId],
    queryFn: () => listProjectResourceGrants(projectId),
    enabled: canManage,
    retry: false,
    staleTime: 30_000,
  });
  // Live capability gate: even if the grants cache still holds data from when the
  // viewer was a manager, a now-non-manager never sees it.
  if (!canManage) return null;
  const assigned = (grantsQuery.data?.grants ?? []).filter(
    (g) => g.resource_type === 'agent' && g.resource_id === agentName,
  );
  if (assigned.length === 0) return null;
  return (
    <div className="border-border/60 bg-muted/20 space-y-2.5 rounded-lg border p-4">
      <div className="flex items-center gap-2">
        <Users className="text-muted-foreground/70 size-3.5 shrink-0" />
        <span className="text-foreground/80 text-xs font-medium">Assigned to</span>
        <Badge variant="muted" size="xs">
          {assigned.length}
        </Badge>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {assigned.map((g) => (
          <Badge key={g.grant_id} variant="outline" size="xs" className="gap-1 font-medium">
            {g.principal_type === 'group' ? (
              <Users className="size-3 shrink-0" />
            ) : (
              <User className="size-3 shrink-0" />
            )}
            {g.principal_label}
            {g.principal_type === 'group' ? ' · group' : ''}
          </Badge>
        ))}
      </div>
      <p className="text-muted-foreground/50 text-[11px] leading-relaxed">
        These members &amp; groups inherit this agent&apos;s declared secrets &amp; connectors as
        their own — usable in Secrets, sessions, and connector calls.
      </p>
    </div>
  );
}

export default AgentAssignments;
