'use client';

import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { Icon } from '@/features/icon/icon';
import { CHANNELS } from '@/features/marketing/v2/content';
import { Lead, MAX_W, Pill } from '@/features/marketing/v2/primitives';
import { ChevronRight } from 'lucide-react';

const DOCK = [Icon.Linear, Icon.Slack, Icon.Github, Icon.Notion, Icon.Gmail];

/** Tag @Kortix where the work is happening. */
export function ConnectorsSection() {
  return (
    <section id="channels" className="scroll-mt-24 py-20 sm:py-28">
      <div className={MAX_W}>
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-foreground text-[2.25rem] leading-[1.08] font-medium tracking-[-0.02em] sm:text-[3rem]">
            <span className="block">
              Tag <span className="text-kortix-blue bg-kortix-blue/10 rounded px-2">@Kortix</span>{' '}
              where
            </span>
            <span className="block">the work is happening</span>
          </h2>
          <Lead className="mt-6">{CHANNELS.subheading}</Lead>

          <div className="mt-9 flex items-center justify-center gap-3">
            <div className="flex -space-x-3">
              {DOCK.slice(0, 3).map((Glyph, i) => (
                <span
                  key={i}
                  className="bg-background flex size-11 items-center justify-center rounded-full shadow-[0_2px_10px_-2px_rgba(26,31,46,0.2)]"
                >
                  <Glyph className="size-5" />
                </span>
              ))}
            </div>
            <span className="text-foreground text-[0.9375rem] font-medium">
              {CHANNELS.integrationsLabel}
            </span>
          </div>
        </div>

        <div className="relative mt-16">
          <SlackMock />
          {/* the dock, on its own little platform */}
          <div className="pointer-events-none absolute inset-x-0 -bottom-8 flex justify-center">
            <div
              className="flex items-end gap-4 rounded-[1.25rem] px-6 py-4"
              style={{
                background:
                  'linear-gradient(160deg, color-mix(in oklab, var(--kortix-blue) 20%, var(--background)) 0%, color-mix(in oklab, var(--kortix-blue) 9%, var(--background)) 100%)',
              }}
            >
              {DOCK.map((Glyph, i) => (
                <span
                  key={i}
                  className="bg-background flex size-14 items-center justify-center rounded-[0.9rem] shadow-[0_6px_18px_-4px_rgba(26,31,46,0.22)]"
                >
                  <Glyph className="size-7" />
                </span>
              ))}
            </div>
          </div>
        </div>

        <div className="mt-24 text-center">
          <p className="text-muted-foreground text-[1.0625rem] leading-[1.6]">
            {CHANNELS.caption.map((line) => (
              <span key={line} className="block">
                {line}
              </span>
            ))}
          </p>
          <Pill as="a" href="/marketplace" variant="soft" className="mt-7">
            {CHANNELS.cta}
            <ChevronRight className="size-4" />
          </Pill>
        </div>
      </div>
    </section>
  );
}

function SlackMock() {
  const s = CHANNELS.slack;
  return (
    <div
      className="bg-background overflow-hidden rounded-[1.25rem]"
      style={{
        border: '1px solid color-mix(in oklab, var(--kortix-blue) 12%, transparent)',
        boxShadow: '0 24px 60px -18px rgba(26,31,46,0.18)',
      }}
    >
      <div className="border-border flex items-center gap-2.5 border-b px-5 py-4">
        <Icon.Slack className="size-5" />
        <span className="text-foreground text-[15px] font-semibold">Kortix</span>
        <span className="bg-muted text-muted-foreground rounded px-1.5 py-px text-[10px] font-medium">
          APP
        </span>
        <span className="text-muted-foreground ml-auto font-mono text-[12px]">{s.channel}</span>
      </div>

      <div className="space-y-6 p-6 sm:p-8">
        <div className="flex items-start gap-3">
          <span className="bg-muted text-foreground flex size-9 shrink-0 items-center justify-center rounded-lg text-[13px] font-semibold">
            M
          </span>
          <div>
            <p className="text-foreground text-[15px] font-semibold">Marko</p>
            <p className="text-muted-foreground mt-0.5 text-[15px]">{s.ask}</p>
          </div>
        </div>

        <div className="flex items-start gap-3">
          <span className="bg-foreground flex size-9 shrink-0 items-center justify-center rounded-lg">
            <KortixLogo size={17} variant="symbol" className="text-background" />
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="text-foreground text-[15px] font-semibold">Kortix</span>
              <span className="bg-muted text-muted-foreground rounded px-1.5 py-px text-[10px] font-medium">
                APP
              </span>
            </div>
            <div className="mt-1.5 space-y-2 text-[15px]">
              <p className="text-foreground font-medium">{s.answerLead}</p>
              <ul className="text-muted-foreground space-y-1.5">
                {s.answer.map((line) => (
                  <li key={line}>· {line}</li>
                ))}
              </ul>
              <p className="text-muted-foreground">{s.tail}</p>
            </div>
          </div>
        </div>
      </div>

      <div className="px-6 pb-20 sm:px-8">
        <div className="border-border text-muted-foreground rounded-xl border px-4 py-3 text-[15px]">
          Message Kortix…
        </div>
      </div>
    </div>
  );
}
