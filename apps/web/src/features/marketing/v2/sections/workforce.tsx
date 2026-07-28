'use client';

import { WORKFORCE } from '@/features/marketing/v2/content';
import { Stage } from '@/features/marketing/v2/illustrations';
import { Eyebrow, Heading, Lead, LedeBullet, Section } from '@/features/marketing/v2/primitives';
import { cn } from '@/lib/utils';
import { GitMerge } from 'lucide-react';

const STATE_STYLE = {
  running: { label: 'Running', dot: 'bg-kortix-blue', text: 'text-kortix-blue' },
  review: { label: 'Needs review', dot: 'bg-kortix-orange', text: 'text-kortix-orange' },
  merged: { label: 'Merged', dot: 'bg-kortix-green', text: 'text-kortix-green' },
};

export function WorkforceSection() {
  return (
    <Section id="workforce">
      <div className="grid items-center gap-10 lg:grid-cols-2 lg:gap-16">
        <div>
          <Eyebrow>{WORKFORCE.eyebrow}</Eyebrow>
          <Heading lines={WORKFORCE.heading} className="mt-6" />
          <Lead className="mt-6">{WORKFORCE.description}</Lead>
          <div className="mt-10">
            {WORKFORCE.bullets.map((b) => (
              <LedeBullet key={b.lede} lede={b.lede} rest={b.rest} />
            ))}
          </div>
        </div>

        <Stage className="min-h-[26rem] p-6 sm:p-8">
          <div className="flex h-full flex-col justify-center gap-2.5">
            {WORKFORCE.sessions.map((session, i) => {
              const s = STATE_STYLE[session.state];
              return (
                <div
                  key={session.title}
                  className="border-border bg-background rounded-sm border px-4 py-3 shadow-xs"
                  style={{ marginLeft: `${Math.min(i, 3) * 0.9}rem` }}
                >
                  <p className="text-foreground truncate text-[13px]">{session.title}</p>
                  <div className="mt-1.5 flex items-center gap-2">
                    <span className={cn('flex items-center gap-1 text-[11px]', s.text)}>
                      <span className={cn('size-1.5 rounded-full', s.dot)} />
                      {s.label}
                    </span>
                    <span className="text-muted-foreground text-[11px]">·</span>
                    <span className="text-muted-foreground font-mono text-[11px]">
                      {session.agent}
                    </span>
                  </div>
                </div>
              );
            })}

            <div className="text-muted-foreground mt-2 flex items-center gap-2 pl-1 font-mono text-[11px]">
              <GitMerge className="text-kortix-green size-3.5" />
              main · always running, always improving
            </div>
          </div>
        </Stage>
      </div>
    </Section>
  );
}
