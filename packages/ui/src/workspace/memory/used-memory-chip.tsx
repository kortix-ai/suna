'use client';

import type { SessionMemoryUsage } from '@kortix/sdk';
import { useProjectMemoryPages, useSessionMemoryUsage } from '@kortix/sdk/react';
import { CaretRightIcon, SunDimIcon } from '@phosphor-icons/react';
import { useState } from 'react';

import { useLocale, useTranslations } from '../../i18n';
import { cn } from '../../lib/utils';
import { Popover, PopoverContent, PopoverTrigger } from '../../primitives/popover';
import { UiLink as Link } from '../../providers/ui-provider';
import { agentLabel } from '../spaces/space-timeline';
import { MEMORY_TYPE_ICON } from './memory-labels';
import { useMemoryPageHref } from '../../internal/lib/memory-href';

type UsageLayer = SessionMemoryUsage['layers'][number];

const ROW = 'flex h-7.5 w-full items-center gap-2 rounded-md px-2 text-left text-xs';

/** A layer's name in the chip: "Company", "#marketing", or the DM's agent. */
function useLayerName(): (layer: UsageLayer) => string {
  const t = useTranslations('spaces.memory.used');
  return (layer) => (layer.scope === 'company' ? t('company') : layer.scope === 'dm' ? agentLabel(layer.name) : layer.name);
}

/**
 * "Used #marketing memory · 3 pages ›" under a thread's first prompt: the
 * pages its agent was given at the first turn. It reads the record only once
 * `ready` (a turn has finished): before that the record is empty, and nothing
 * polls it. A turn that ends while the record is still empty reads it again.
 * Hidden when the thread loaded no page.
 */
export function UsedMemoryChip({
  projectId,
  sessionId,
  ready,
  className,
}: {
  projectId: string;
  sessionId: string;
  /** A turn of the thread has finished. */
  ready: boolean;
  className?: string;
}) {
  const t = useTranslations('spaces.memory.used');
  const locale = useLocale();
  const layerName = useLayerName();
  const [open, setOpen] = useState(false);
  const usage = useSessionMemoryUsage(projectId, sessionId, { enabled: ready });
  const layers = usage.data?.loaded_at ? usage.data.layers.filter((layer) => layer.pages.length > 0) : [];
  const count = layers.reduce((sum, layer) => sum + layer.pages.length, 0);
  if (count === 0) return null;
  const places = new Intl.ListFormat(locale, { type: 'conjunction' }).format(layers.map(layerName));
  return (
    <div className={cn('flex py-1', className)}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="group/used text-muted-foreground hover:bg-hover hover:text-foreground focus-visible:ring-ring -mx-1 flex max-w-full items-center gap-1.5 rounded-md px-1 py-0.5 text-xs outline-none focus-visible:ring-2"
          >
            <SunDimIcon aria-hidden className="size-4 shrink-0" />
            <span className="min-w-0 truncate">{t('label', { places, count })}</span>
            <CaretRightIcon aria-hidden className="size-3 shrink-0" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="flex max-h-96 w-80 flex-col gap-1 overflow-y-auto p-1.5">
          <p className="text-muted-foreground px-2 pt-1 pb-0.5 text-xs">{t('title')}</p>
          {layers.map((layer) => (
            <UsedLayer key={layer.layer_key} projectId={projectId} layer={layer} name={layerName(layer)} open={open} onOpen={() => setOpen(false)} />
          ))}
        </PopoverContent>
      </Popover>
    </div>
  );
}

/**
 * One layer's pages. A page deleted since the thread started is shown as
 * removed, read from the layer's live list (the one the Memory tab shares).
 */
function UsedLayer({
  projectId,
  layer,
  name,
  open,
  onOpen,
}: {
  projectId: string;
  layer: UsageLayer;
  name: string;
  open: boolean;
  onOpen: () => void;
}) {
  const t = useTranslations('spaces.memory.used');
  const live = useProjectMemoryPages(projectId, layer.layer_key, { enabled: open });
  const href = useMemoryPageHref(projectId, open);
  return (
    <section className="flex flex-col pt-1.5">
      <p className="px-2 pb-0.5 text-xs font-medium">{name}</p>
      {layer.pages.map((page) => {
        const Glyph = MEMORY_TYPE_ICON[page.type];
        const removed = !!live.data && !live.data.some((candidate) => candidate.page_id === page.page_id);
        const target = removed ? null : href({ scope: layer.scope, key: layer.layer_key }, page.page_id);
        const body = (
          <>
            <Glyph aria-hidden className="text-muted-foreground size-3.5 shrink-0" />
            <span className={cn('min-w-0 flex-1 truncate', removed && 'text-muted-foreground')}>{page.title}</span>
            {removed ? <span className="text-muted-foreground shrink-0">{t('removed')}</span> : null}
          </>
        );
        return target ? (
          <Link
            key={page.page_id}
            href={target}
            onClick={onOpen}
            className={cn(ROW, 'hover:bg-hover focus-visible:ring-ring outline-none focus-visible:ring-2')}
          >
            {body}
          </Link>
        ) : (
          <div key={page.page_id} className={ROW}>
            {body}
          </div>
        );
      })}
    </section>
  );
}
