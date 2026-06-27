'use client';

import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useProjectConfig } from '@kortix/sdk/react';
import { Bot, type LucideIcon, Slash, Sparkles } from 'lucide-react';

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
      <Section
        icon={Bot}
        title="Agents"
        items={config.agents}
        defaultName={config.open_code_default_agent}
      />
      <Section icon={Slash} title="Commands" items={config.commands} prefix="/" />
      <Section icon={Sparkles} title="Skills" items={config.skills} />
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
  icon: LucideIcon;
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
              {defaultName === it.name && <span className="text-xs text-brand">default</span>}
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
