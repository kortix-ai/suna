'use client';

import { Card } from '@kortix/ui/card';
import { Skeleton } from '@kortix/ui/skeleton';
import { useProjectConfig } from '@kortix/sdk/react';
import { RobotIcon, SparkleIcon, TerminalIcon, type Icon } from '@phosphor-icons/react';

/**
 * Read-only view of the project's server-side capabilities — agents, slash
 * commands, and skills — all from `useProjectConfig` (one server fetch, no
 * runtime). The same source powers the agent picker + the composer's command
 * menu; this tab just makes the full roster visible.
 */
export function CapabilitiesTab({ projectId }: { projectId: string }) {
  const config = useProjectConfig(projectId);
  if (!config) return <Skeleton className="h-40 rounded-xl" />;

  return (
    <div className="space-y-4">
      <Section icon={RobotIcon} title="Agents" items={config.agents} defaultName={config.default_agent} />
      <Section icon={TerminalIcon} title="Commands" items={config.commands} prefix="/" />
      <Section icon={SparkleIcon} title="Skills" items={config.skills} />
    </div>
  );
}

function Section({
  icon: Icon,
  title,
  items,
  prefix = '',
  defaultName,
}: {
  icon: Icon;
  title: string;
  items: Array<{ name: string; description: string | null }>;
  prefix?: string;
  defaultName?: string | null;
}) {
  return (
    <Card className="p-0">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <Icon className="size-4 text-muted-foreground" />
        <span className="text-sm font-medium">{title}</span>
        <span className="ml-auto text-xs text-muted-foreground">{items.length}</span>
      </div>
      <div className="divide-y divide-border">
        {items.length === 0 && <div className="px-4 py-4 text-sm text-muted-foreground">None.</div>}
        {items.map((it) => (
          <div key={it.name} className="px-4 py-3">
            <div className="flex items-center gap-2 text-sm">
              <span className="font-mono capitalize">
                {prefix}
                {it.name}
              </span>
              {defaultName === it.name && (
                <span className="text-xs text-muted-foreground">default</span>
              )}
            </div>
            {it.description && (
              <div className="mt-0.5 text-xs text-muted-foreground">{it.description}</div>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}
