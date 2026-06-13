'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EntityAvatar } from '@/components/ui/entity-avatar';
import { InlineMeta } from '@/components/ui/inline-meta';
import { Plus } from 'lucide-react';
import { AGENTS, favicon, type AgentDef } from '../data';
import { PageHead, StatusDot } from '../primitives';

function AgentCard({ agent }: { agent: AgentDef }) {
  return (
    <div className="border-border/70 bg-card hover:border-border hover:bg-muted/20 flex flex-col rounded-md border p-3.5 transition-colors">
      <div className="flex items-start gap-3">
        <EntityAvatar icon={agent.icon} size="lg" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-foreground truncate text-sm font-semibold">{agent.name}</span>
            <Badge size="sm" variant="muted" className="font-mono">
              {agent.trigger}
            </Badge>
          </div>
          <p className="text-muted-foreground mt-1 line-clamp-2 text-xs leading-relaxed">
            {agent.desc}
          </p>
        </div>
        <StatusDot on={agent.on} label={['active', 'idle']} />
      </div>
      <div className="border-border/60 mt-3 border-t pt-2.5">
        <InlineMeta>
          <span className="inline-flex items-center gap-1">
            <img
              src={favicon(agent.modelDomain)}
              alt=""
              width={12}
              height={12}
              loading="lazy"
              onError={(e) => {
                e.currentTarget.style.display = 'none';
              }}
              className="size-3 shrink-0 rounded-sm"
            />
            {agent.model}
          </span>
          <span>{agent.runs} runs</span>
          <span>{agent.last}</span>
        </InlineMeta>
      </div>
    </div>
  );
}

export function AgentsPage() {
  const running = AGENTS.filter((a) => a.on).length;
  const triggered = AGENTS.filter((a) => a.trigger !== 'manual' && a.trigger !== 'primary').length;
  const stats: [string, string][] = [
    [String(AGENTS.length), 'Agents'],
    [String(running), 'Running now'],
    ['22.2k', 'Runs · 7d'],
    [String(triggered), 'Auto-triggered'],
  ];
  return (
    <div>
      <PageHead
        title="Agents"
        sub="Each agent is its own worker — defined in .kortix/opencode/agents"
        action={
          <Button variant="default" size="sm">
            <Plus className="size-3.5" /> New agent
          </Button>
        }
      />

      <div className="mb-4 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        {stats.map(([n, l]) => (
          <div key={l} className="border-border/70 bg-card rounded-md border px-3 py-2.5">
            <div className="text-foreground text-lg font-semibold tracking-tight">{n}</div>
            <div className="text-muted-foreground mt-0.5 text-xs">{l}</div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-2.5 lg:grid-cols-2">
        {AGENTS.map((a) => (
          <AgentCard key={a.name} agent={a} />
        ))}
      </div>
    </div>
  );
}
