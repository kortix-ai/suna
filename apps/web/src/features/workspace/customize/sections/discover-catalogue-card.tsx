'use client';

import { useTranslations } from '@/i18n/use-translations';
import type { DiscoverConnector, PipedreamApp } from '@kortix/sdk';
import { CaretRightIcon as ChevronRight, GlobeIcon as Globe, PlusIcon as Plus, LightningIcon as Zap } from '@phosphor-icons/react';
import Image from 'next/image';
import { Badge } from '@/components/ui/badge';
import { EntityAvatar } from '@/components/ui/entity-avatar';

export type DiscoverCard =
  { source: 'connector'; item: DiscoverConnector } | { source: 'pipedream'; app: PipedreamApp };

export function DiscoverCatalogueCard({ card, addConnector, setConnectorTarget, setSelectedConnector }: {
  card: DiscoverCard;
  addConnector: { isPending: boolean };
  setConnectorTarget: (target: { source: 'pipedream'; app: PipedreamApp }) => void;
  setSelectedConnector: (item: DiscoverConnector) => void;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
              const isOAuth = card.source === 'pipedream';
              const name = isOAuth ? card.app.name : card.item.name;
              const description = isOAuth ? card.app.description : card.item.description;
              const icon = isOAuth ? card.app.imgSrc : card.item.icon;
              const key = isOAuth ? `pipedream:${card.app.slug}` : card.item.id;
              // The public index often has one feed entry (commonly MCP) for a
              // domain whose surface document contains APIs, CLIs, and more.
              const subtitle = isOAuth
                ? tI18nComplete.raw('text87a46ec2620a')
                : tI18nComplete.raw('text678094dc2f3f');
              return (
                <button
                  key={key}
                  type="button"
                  disabled={addConnector.isPending}
                  onClick={() =>
                    isOAuth
                      ? setConnectorTarget({ source: 'pipedream', app: card.app })
                      : setSelectedConnector(card.item)
                  }
                  className="group bg-popover hover:bg-muted/80 focus-visible:ring-primary/50 flex min-h-28 flex-col rounded-md border p-3.5 text-left transition-[background-color,transform] focus-visible:ring-2 focus-visible:outline-none active:scale-[0.96] disabled:opacity-60"
                >
                  <div className="flex items-center gap-3">
                    {icon ? (
                      <Image
                        src={icon}
                        alt=""
                        width={36}
                        height={36}
                        className="ring-foreground/10 size-8 shrink-0 rounded-md object-contain ring-1"
                        referrerPolicy="no-referrer"
                        unoptimized
                      />
                    ) : (
                      <EntityAvatar icon={isOAuth ? Zap : Globe} size="sm" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="text-foreground truncate text-sm font-medium">{name}</div>
                      <Badge variant={isOAuth ? 'kortix' : 'outline'} size="xs">
                        {subtitle}
                      </Badge>
                    </div>
                    {isOAuth ? (
                      <Plus className="text-muted-foreground/40 group-hover:text-primary size-4 shrink-0 transition-colors" />
                    ) : (
                      <ChevronRight className="text-muted-foreground/40 group-hover:text-primary size-4 shrink-0 transition-colors" />
                    )}
                  </div>
                  <p className="text-muted-foreground mt-2 line-clamp-2 min-h-8 text-xs leading-relaxed">
                    {description ??
                      (isOAuth
                        ? tI18nComplete.raw('textc618c6bd416a')
                        : tI18nComplete.raw('text673760b857d0'))}
                  </p>
                </button>
              );
}
