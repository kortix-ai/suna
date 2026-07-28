'use client';

import { OPEN } from '@/features/marketing/v2/content';
import { SlabMark } from '@/features/marketing/v2/illustrations';
import { CheckLine, Display, Lead, Panel, Pill } from '@/features/marketing/v2/primitives';
import { Cloud, Landmark, ShieldCheck, WifiOff } from 'lucide-react';

const CARD_GLYPHS = [Landmark, ShieldCheck, Cloud, WifiOff];

export function SelfHostSection() {
  return (
    <Panel id="open">
      <div className="px-8 pt-14 pb-12 sm:px-14 sm:pt-16">
        <div className="grid gap-10 lg:grid-cols-2 lg:gap-16">
          <div>
            <Display lines={OPEN.heading} />
            <Pill as="a" href="/enterprise" className="mt-9">
              Explore self-hosted
            </Pill>
          </div>

          <div className="lg:pt-2">
            <Lead>{OPEN.description}</Lead>
            <div className="border-border mt-8 grid gap-5 border-t pt-8 sm:grid-cols-2">
              {OPEN.checks.map((check) => (
                <CheckLine key={check}>{check}</CheckLine>
              ))}
            </div>
          </div>
        </div>

        <div className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {OPEN.cards.map((card, i) => {
            const Glyph = CARD_GLYPHS[i % CARD_GLYPHS.length];
            return (
              <div
                key={card.name}
                className="bg-background/55 flex flex-col rounded-[1.1rem] p-6 backdrop-blur-sm"
                style={{ border: '1px solid color-mix(in oklab, var(--kortix-blue) 12%, transparent)' }}
              >
                <SlabMark
                  count={(i % 3) + 1}
                  tone="accent"
                  glyph={<Glyph className="size-14" strokeWidth={1.15} />}
                />
                <p className="text-foreground mt-6 text-[1.125rem] font-medium">{card.name}</p>
                <p className="text-muted-foreground mt-2 text-[0.9375rem] leading-[1.5]">
                  {card.description}
                </p>
              </div>
            );
          })}
        </div>

        <div className="border-border mt-12 flex flex-col gap-6 border-t pt-8 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-muted-foreground text-[0.9375rem] leading-[1.5]">
            {OPEN.footerLabel.map((line) => (
              <span key={line} className="block">
                {line}
              </span>
            ))}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {OPEN.clouds.map((cloud) => (
              <span
                key={cloud}
                className="bg-background/70 text-muted-foreground rounded-full px-4 py-1.5 text-[13px] font-medium"
                style={{ border: '1px solid color-mix(in oklab, var(--kortix-blue) 12%, transparent)' }}
              >
                {cloud}
              </span>
            ))}
          </div>
        </div>
      </div>
    </Panel>
  );
}
