'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Key as KeyRound, Plus, Sparkles as HiMiniSparkles, Microchip as RiCpuLine } from '@mynaui/icons-react';
import { useTranslations } from 'next-intl';
import { PROVIDERS } from '../data';
import { BrandLogo, ConnectBadge, PageHead } from '../primitives';

export function ModelsPage() {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  return (
    <div>
      <PageHead
        title="Models"
        sub={tI18nHardcoded.raw(
          'autoComponentsHomeInteractiveDemoPagesModelsPageJsxAttrSubb32ed537',
        )}
        action={
          <Button variant="default" size="sm">
            <Plus className="size-3.5" />{' '}
            {tI18nHardcoded.raw(
              'autoComponentsHomeInteractiveDemoPagesModelsPageJsxTextAdd2c76a9b7',
            )}
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
        {tI18nHardcoded.raw(
          'autoComponentsHomeInteractiveDemoPagesModelsPageJsxTextConnecting6d7cacee',
        )}
      </div>
    </div>
  );
}
