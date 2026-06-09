'use client';

import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { ArrowRight, Blocks, Search } from 'lucide-react';
import { CONNECTOR_TYPES, INTEGRATIONS } from '../data';
import { BrandLogo, ConnectBadge } from '../primitives';

export function IntegrationsPage() {
  const [q, setQ] = useState('');
  const query = q.trim().toLowerCase();
  const list = INTEGRATIONS.filter(
    ([domain, name]) =>
      !query || name.toLowerCase().includes(query) || domain.toLowerCase().includes(query),
  );
  return (
    <div>
      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="min-w-0">
          <h3 className="text-foreground text-lg font-semibold tracking-tight">Integrations</h3>
          <p className="text-muted-foreground mt-0.5 text-sm">
            3,000+ apps · connected once, shared securely across the org
          </p>
        </div>

        <div className="flex items-center gap-2 sm:shrink-0">
          {/* <div className="border-border bg-card focus-within:ring-primary/40 flex h-8 min-w-0 flex-1 items-center gap-2 rounded-full border px-3 focus-within:ring-2 sm:w-52 sm:flex-none">
            <Search className="text-muted-foreground size-3.5 shrink-0" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search apps…"
              aria-label="Search apps"
              className="placeholder:text-muted-foreground/60 text-foreground w-full min-w-0 bg-transparent text-sm outline-none"
            />
            {q && (
              <button
                type="button"
                onClick={() => setQ('')}
                aria-label="Clear search"
                className="text-muted-foreground/60 hover:text-foreground shrink-0 text-sm leading-none"
              >
                ✕
              </button>
            )}
          </div> */}
          <div className="border-border bg-card mb-4 flex h-9 items-center gap-2 rounded-md border px-3">
            <Search className="text-muted-foreground size-3.5 shrink-0" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search apps…"
              className="placeholder:text-muted-foreground/60 text-foreground w-full bg-transparent text-sm outline-none"
            />
            {q && (
              <button
                onClick={() => setQ('')}
                className="text-muted-foreground hover:text-foreground text-xs"
              >
                Clear
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        {CONNECTOR_TYPES.map((t, i) => (
          <Badge
            key={t}
            // size="sm"
            variant={i === 0 ? 'highlight' : 'outline'}
            // className="font-mono"
          >
            {t}
          </Badge>
        ))}
        <span className="text-muted-foreground ml-1 text-xs">
          Pipedream, MCP, OpenAPI, GraphQL & raw HTTP — one Executor interface
        </span>
      </div>

      {list.length > 0 ? (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {list.map(([domain, name, connected]) => (
            <div
              key={name}
              className="border-border/60 bg-card flex items-center gap-2.5 rounded-md border p-2.5"
            >
              <BrandLogo domain={domain} alt={name} />
              <span className="text-foreground truncate text-sm font-medium">{name}</span>
              <ConnectBadge connected={connected} />
            </div>
          ))}
        </div>
      ) : (
        <div className="border-border/60 text-muted-foreground rounded-md border border-dashed py-8 text-center text-sm">
          No featured app matches “{q}”.
        </div>
      )}

      <button className="border-border/60 bg-muted/20 hover:bg-muted/40 mt-2.5 flex w-full items-center justify-center gap-2 rounded-md border border-dashed py-3 text-sm transition-colors">
        <Blocks className="text-muted-foreground size-4" />
        <span className="text-foreground font-medium">
          {query ? `Search “${q}” across all 3,000+ apps` : 'Browse all 3,000+ apps'}
        </span>
        <ArrowRight className="text-muted-foreground size-3.5" />
      </button>
    </div>
  );
}
