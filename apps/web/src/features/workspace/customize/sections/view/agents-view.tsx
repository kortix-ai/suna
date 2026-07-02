'use client';

import { useQuery } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { ConfigEntityView } from '@/features/workspace/customize/sections/component/config-entity-view';
import { formatMode } from '@/features/workspace/customize/shared/utils';
import { listProjectAccess, listProjectResourceGrants, type ProjectConfigSummary } from '@kortix/sdk/projects-client';
import { StarSolid } from '@mynaui/icons-react';
import { Bot, ShieldCheck, User, Users } from 'lucide-react';

type Agent = ProjectConfigSummary['agents'][number];

export function AgentsView({ projectId }: { projectId: string }) {
  return (
    <ConfigEntityView<Agent>
      projectId={projectId}
      kind="agent"
      noun="agent"
      title="Agents"
      description="Pick an agent from the list to preview it, or create a new one."
      docs="https://kortix.com/docs/concepts/agents"
      searchPlaceholder="Search agents"
      emptyIcon={Bot}
      emptyTitle="No agents yet"
      emptyDescription="Create an agent to customize how sessions run."
      emptyDocsHref="https://opencode.ai/docs/agents/"
      emptyBodyLabel="Agent body is empty. Add prompt content below the frontmatter."
      select={(config) => config.agents}
      renderTriggerLabel={(agent) => agent.name}
      renderRowTrailing={(agent, config) => (
        <>
          {agent.mode ? (
            <Badge variant="muted" size="xs">
              {formatMode(agent.mode)}
            </Badge>
          ) : null}
          {config.open_code_default_agent === agent.name ? (
            <StarSolid className="text-kortix-orange size-4 shrink-0 fill-current" />
          ) : null}
        </>
      )}
      renderDetailTitle={(agent) => agent.name}
      renderDetailMeta={(agent, config) => (
        <>
          {agent.mode ? (
            <Badge variant="outline" size="sm" className="text-muted-foreground font-medium">
              {formatMode(agent.mode)}
            </Badge>
          ) : null}
          {agent.source ? (
            <Badge variant="outline" size="sm" className="text-muted-foreground font-mono">
              {agent.source === 'kortix.toml' ? 'kortix.toml' : 'OpenCode'}
            </Badge>
          ) : null}
          {config.open_code_default_agent === agent.name ? (
            <Badge variant="outline" size="sm" className="text-muted-foreground gap-1 font-medium">
              <StarSolid className="text-kortix-orange size-3.5 shrink-0" />
              Default
            </Badge>
          ) : null}
          {agent.enabled === false ? (
            <Badge variant="muted" size="sm">
              Disabled
            </Badge>
          ) : null}
        </>
      )}
      renderDetailExtra={(agent) => (
        <div className="space-y-3">
          <AgentAssignments projectId={projectId} agentName={agent.name} />
          <AgentScope scope={agent.scope} />
        </div>
      )}
    />
  );
}

/**
 * Who inherits this agent — the members/departments assigned to it (Members →
 * Resource access). Each inherits the agent's declared secrets & connectors as
 * their own. Manager-only data: gated on a LIVE can_manage capability so it never
 * fires the manager-only grants endpoint (no 403 / error toast) and never renders
 * stale cached assignments to someone whose manager role was just revoked.
 */
function AgentAssignments({ projectId, agentName }: { projectId: string; agentName: string }) {
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
            {g.principal_type === 'group' ? ' · dept' : ''}
          </Badge>
        ))}
      </div>
      <p className="text-muted-foreground/50 text-[11px] leading-relaxed">
        These members &amp; departments inherit this agent's declared secrets &amp; connectors (below)
        as their own — usable in Secrets, sessions, and connector calls.
      </p>
    </div>
  );
}

/**
 * Read-only mirror of an agent's `kortix.toml [[agents]]` allowlists — which
 * secrets it receives in $ENV, which connectors it may use, which Kortix CLI
 * powers it has. Editing stays in kortix.toml (a PR-reviewed, editor-tier
 * change), so this is presentation only. Absent for OpenCode-discovered agents,
 * which aren't governed by [[agents]].
 */
function AgentScope({ scope }: { scope?: Agent['scope'] }) {
  if (!scope) return null;
  return (
    <div className="border-border/60 bg-muted/20 space-y-2.5 rounded-lg border p-4">
      <div className="flex items-center gap-2">
        <ShieldCheck className="text-muted-foreground/70 size-3.5 shrink-0" />
        <span className="text-foreground/80 text-xs font-medium">Access scope</span>
        <Badge variant="muted" size="xs" className="font-mono">
          kortix.toml [[agents]]
        </Badge>
      </div>
      <ScopeRow label="Secrets" value={scope.env} />
      <ScopeRow label="Connectors" value={scope.connectors} />
      <ScopeRow label="CLI" value={scope.kortix_cli} />
      <p className="text-muted-foreground/50 text-[11px] leading-relaxed">
        Read-only — edit the allowlists in kortix.toml. “All” means every item the launching user
        can see; “None” means the agent is fully scoped out. Members you assign to this agent
        (Members → Resource access) inherit its declared secrets &amp; connectors.
      </p>
    </div>
  );
}

function ScopeRow({ label, value }: { label: string; value: string[] | 'all' }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1.5">
      <span className="text-muted-foreground/70 w-24 shrink-0 text-[11px] font-medium tracking-wide uppercase">
        {label}
      </span>
      {value === 'all' ? (
        <Badge variant="muted" size="xs">
          All
        </Badge>
      ) : value.length === 0 ? (
        <Badge variant="muted" size="xs">
          None
        </Badge>
      ) : (
        value.map((key) => (
          <Badge key={key} variant="outline" size="xs" className="font-mono">
            {key}
          </Badge>
        ))
      )}
    </div>
  );
}
