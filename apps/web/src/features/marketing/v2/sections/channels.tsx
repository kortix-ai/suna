'use client';

import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { Icon } from '@/features/icon/icon';
import { CHANNELS } from '@/features/marketing/v2/content';
import { Stage } from '@/features/marketing/v2/illustrations';
import { Eyebrow, Heading, Lead, Section } from '@/features/marketing/v2/primitives';
import { Code2, Mail, MessageCircle, Monitor } from 'lucide-react';

const SURFACE_ICONS = [
  Icon.Slack,
  Icon.MicrosoftTeams,
  MessageCircle,
  Mail,
  Monitor,
  Code2,
] as const;

export function ChannelsSection() {
  return (
    <Section id="channels">
      <div className="mx-auto max-w-2xl text-center">
        <Eyebrow>{CHANNELS.eyebrow}</Eyebrow>
        <Heading lines={CHANNELS.heading} className="mt-6" />
        <Lead className="mt-5">{CHANNELS.subheading}</Lead>
      </div>

      <div className="mt-14 grid gap-6 lg:grid-cols-[1.1fr_0.9fr] lg:gap-10">
        <Stage className="min-h-[24rem] p-6 sm:p-10">
          <SlackThread />
        </Stage>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1">
          {CHANNELS.surfaces.map((surface, i) => {
            const Glyph = SURFACE_ICONS[i % SURFACE_ICONS.length];
            return (
              <div
                key={surface.name}
                className="border-border bg-card flex items-center gap-3.5 rounded-sm border px-4 py-3.5"
              >
                <span className="border-border bg-background flex size-9 shrink-0 items-center justify-center rounded-sm border">
                  <Glyph className="size-4" />
                </span>
                <div className="min-w-0">
                  <p className="text-foreground text-[13px] font-medium">{surface.name}</p>
                  <p className="text-muted-foreground truncate text-[12px]">{surface.note}</p>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </Section>
  );
}

function SlackThread() {
  const s = CHANNELS.slack;
  return (
    <div className="border-border bg-background h-full overflow-hidden rounded-sm border shadow-md">
      <div className="border-border flex items-center gap-2 border-b px-4 py-3">
        <Icon.Slack className="size-4" />
        <span className="text-foreground text-[13px] font-semibold">Kortix</span>
        <span className="bg-muted text-muted-foreground rounded-sm px-1 py-px text-[9px] font-medium">
          APP
        </span>
        <span className="text-muted-foreground ml-auto font-mono text-[11px]">{s.channel}</span>
      </div>

      <div className="space-y-5 p-5">
        <div className="flex items-start gap-2.5">
          <span className="bg-muted text-foreground flex size-8 shrink-0 items-center justify-center rounded-sm text-xs font-semibold">
            M
          </span>
          <div>
            <p className="text-foreground text-sm font-semibold">Marko</p>
            <p className="text-muted-foreground mt-0.5 text-sm">{s.ask}</p>
          </div>
        </div>

        <div className="flex items-start gap-2.5">
          <span className="bg-foreground flex size-8 shrink-0 items-center justify-center rounded-sm">
            <KortixLogo size={15} variant="symbol" className="text-background" />
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="text-foreground text-sm font-semibold">Kortix</span>
              <span className="bg-muted text-muted-foreground rounded-sm px-1 py-px text-[9px] font-medium">
                APP
              </span>
            </div>
            <div className="mt-1 space-y-1.5 text-sm">
              <p className="text-foreground font-medium">{s.answerLead}</p>
              <ul className="text-muted-foreground space-y-1">
                {s.answer.map((line) => (
                  <li key={line}>· {line}</li>
                ))}
              </ul>
              <p className="text-muted-foreground">{s.tail}</p>
            </div>
          </div>
        </div>
      </div>

      <div className="border-border border-t p-3">
        <div className="border-border text-muted-foreground rounded-sm border px-3 py-2 text-sm">
          Message Kortix…
        </div>
      </div>
    </div>
  );
}
