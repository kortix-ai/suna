'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { listProjectResourceGrants } from '@kortix/sdk/projects-client';
import { CheckCircleSolid } from '@mynaui/icons-react';
import { useQuery } from '@tanstack/react-query';
import { Bot, Search } from 'lucide-react';
import { useMemo, useState } from 'react';

/**
 * "Which agents can use this secret" control. The secret-side access model that
 * replaced per-member "only me": a secret is usable by ALL agents (project-wide,
 * `value === null`) or restricted to a picked set of agents (`value` = their
 * names). The executor drops the secret from any session whose running agent
 * isn't listed. Values are agent NAMES (the stable grant key = the runtime agent
 * name the executor matches on), not display labels.
 *
 * Semantics of `value`:
 *   • null      → all agents (default)
 *   • []        → "specific agents" chosen but none selected yet (INVALID — the
 *                 caller must block save; never persisted, since [] would clear
 *                 the scope back to all-agents server-side)
 *   • [a, b, …] → restricted to those agents
 */
export function AgentAccessPicker({
  projectId,
  value,
  onChange,
}: {
  projectId: string;
  value: string[] | null;
  onChange: (next: string[] | null) => void;
}) {
  const [query, setQuery] = useState('');
  const mode: 'all' | 'specific' = value === null ? 'all' : 'specific';
  const selected = value ?? [];

  // Manager-only endpoint — but the secret dialog is manager-gated, so it's safe
  // to fire here. Shares the cache key with the Members resource-grants view.
  const agentsQuery = useQuery({
    queryKey: ['project-resource-grants', projectId],
    queryFn: () => listProjectResourceGrants(projectId),
    staleTime: 20_000,
  });
  const agents = agentsQuery.data?.resources.agents ?? [];
  const selectedSet = useMemo(() => new Set(selected), [selected]);

  const q = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    const list = q ? agents.filter((a) => a.name.toLowerCase().includes(q)) : agents;
    // Selected first, then alphabetical — chosen agents stay visible.
    return [...list].sort((a, b) => {
      const d = (selectedSet.has(a.id) ? 0 : 1) - (selectedSet.has(b.id) ? 0 : 1);
      return d !== 0 ? d : a.name.localeCompare(b.name);
    });
  }, [agents, q, selectedSet]);

  const toggle = (id: string) =>
    onChange(selectedSet.has(id) ? selected.filter((x) => x !== id) : [...selected, id]);

  return (
    <div className="space-y-3">
      <Label>Which agents can use this secret</Label>
      <RadioGroup
        value={mode}
        onValueChange={(v) => onChange(v === 'all' ? null : selected)}
        className="space-y-2"
      >
        <RadioGroupItem
          value="all"
          id="agent-access-all"
          label="All agents"
          description="Every agent in this project can use it (default)."
          size="lg"
          variant="outline"
        />
        <RadioGroupItem
          value="specific"
          id="agent-access-specific"
          label="Specific agents"
          description="Only the agents you pick can use it. People inherit it through the agents they're assigned to."
          size="lg"
          variant="outline"
        />
      </RadioGroup>

      {mode === 'specific' && (
        <div className="border-border overflow-hidden rounded-md border">
          <div className="relative overflow-hidden border-b">
            <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 h-3.5 w-3.5 -translate-y-1/2" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search agents"
              className="rounded-b-none pl-9"
              variant="transparent"
            />
          </div>

          {selected.length > 0 && (
            <div className="border-border/60 flex items-center justify-between border-b px-3 py-1.5">
              <span className="text-muted-foreground text-xs">{selected.length} selected</span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs"
                onClick={() => onChange([])}
              >
                Clear
              </Button>
            </div>
          )}

          <div className="max-h-56 overflow-y-auto p-1">
            {agentsQuery.isLoading ? (
              <div className="space-y-1 p-1">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="flex items-center gap-2.5 px-2 py-1.5">
                    <Skeleton className="size-6 rounded-full" />
                    <Skeleton className="h-3.5 w-40" />
                  </div>
                ))}
              </div>
            ) : agents.length === 0 ? (
              <p className="text-muted-foreground px-3 py-6 text-center text-xs">
                No agents declared in this project yet. Add one in Agents, or choose “All agents”.
              </p>
            ) : filtered.length === 0 ? (
              <p className="text-muted-foreground px-3 py-6 text-center text-xs">
                No matches for your search.
              </p>
            ) : (
              filtered.map((a) => {
                const isSelected = selectedSet.has(a.id);
                return (
                  <button
                    key={a.id}
                    type="button"
                    aria-pressed={isSelected}
                    onClick={() => toggle(a.id)}
                    className={cn(
                      'flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors',
                      isSelected ? 'bg-secondary' : 'hover:bg-muted/50',
                    )}
                  >
                    <span className="bg-muted text-muted-foreground flex size-6 shrink-0 items-center justify-center rounded-full">
                      <Bot className="size-3.5" />
                    </span>
                    <span className="text-foreground min-w-0 flex-1 truncate text-sm">
                      {a.name}
                    </span>
                    {isSelected && (
                      <span className="shrink-0 px-1">
                        <CheckCircleSolid className="size-[1.1rem]" />
                      </span>
                    )}
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
