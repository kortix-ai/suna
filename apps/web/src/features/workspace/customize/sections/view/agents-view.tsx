'use client';

import { Badge } from '@/components/ui/badge';
import { ConfigEntityView } from '@/features/workspace/customize/sections/component/config-entity-view';
import { formatMode } from '@/features/workspace/customize/shared/utils';
import type { ProjectConfigSummary } from '@/lib/projects-client';
import { StarSolid } from '@mynaui/icons-react';
import { Bot } from 'lucide-react';

type Agent = ProjectConfigSummary['agents'][number];

export function AgentsView({ projectId, embedded }: { projectId: string; embedded?: boolean }) {
  return (
    <ConfigEntityView<Agent>
      projectId={projectId}
      kind="agent"
      noun="agent"
      embedded={embedded}
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
    />
  );
}

function ContextRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <dt className="text-muted-foreground/70 text-[11px] font-medium tracking-wide uppercase">
        {label}
      </dt>
      <dd className="flex flex-wrap items-center gap-1.5">{children}</dd>
    </div>
  );
}

function EnvRow({
  label,
  keys,
  tone,
}: {
  label: string;
  keys: string[];
  tone: 'required' | 'optional';
}) {
  if (keys.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-muted-foreground/70 w-16 shrink-0 text-[11px] font-medium tracking-wide uppercase">
        {label}
      </span>
      {keys.map((key) => (
        <Badge
          key={key}
          variant={tone === 'required' ? 'outline' : 'muted'}
          size="xs"
          className="font-mono"
        >
          {key}
        </Badge>
      ))}
    </div>
  );
}
