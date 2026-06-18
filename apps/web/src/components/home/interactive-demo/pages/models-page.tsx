'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { KeyRound, Plus } from 'lucide-react';
import { HiMiniSparkles } from 'react-icons/hi2';
import { RiCpuLine } from 'react-icons/ri';
import { PROVIDERS } from '../data';
import { BrandLogo, ConnectBadge, PageHead } from '../primitives';

export function ModelsPage() {
  return (
    <div>
      <PageHead
        title="Models"
        sub="Bring any provider — routed per session, keys stay in Secrets"
        action={
          <Button variant="default" size="sm">
            <Plus className="size-3.5" /> Add provider
          </Button>
        }
      />

      <div className="space-y-2">
        {PROVIDERS.map((p) => (
          <div
            key={p.name}
            className="border-border/60 bg-card flex items-center gap-3 rounded-md border p-2.5"
          >
            {p.domain ? (
              <BrandLogo domain={p.domain} alt={p.name} />
            ) : (
              <span className="bg-foreground text-background flex size-8 shrink-0 items-center justify-center rounded-lg">
                <RiCpuLine className="size-4" />
              </span>
            )}
            <div className="min-w-0 flex-1">
              <div className="text-foreground truncate text-sm font-medium">{p.name}</div>
              <div className="text-muted-foreground truncate text-xs">{p.hint}</div>
            </div>
            {p.state === 'managed' ? (
              <Badge size="sm" variant="highlight" className="shrink-0 gap-1">
                <HiMiniSparkles className="size-3" /> Managed
              </Badge>
            ) : p.state === 'connected' ? (
              <ConnectBadge connected />
            ) : (
              <Button variant="outline" size="sm" className="shrink-0">
                <KeyRound className="size-3.5" /> Connect
              </Button>
            )}
          </div>
        ))}
      </div>

      <div className="border-border/60 bg-muted/20 text-muted-foreground mt-3 flex items-center gap-2 rounded-md border px-3 py-2.5 text-xs">
        <KeyRound className="size-3.5 shrink-0" />
        Connecting a provider writes its API key to Secrets — sessions pick it up at sandbox boot.
      </div>
    </div>
  );
}
