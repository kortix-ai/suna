'use client';

import { SANDBOX } from '@/features/marketing/v2/content';
import { Stage } from '@/features/marketing/v2/illustrations';
import { Eyebrow, Heading, Lead, LedeBullet, Section } from '@/features/marketing/v2/primitives';
import { cn } from '@/lib/utils';
import { Terminal } from 'lucide-react';

export function SandboxSection() {
  return (
    <Section id="sandboxes">
      <div className="grid items-center gap-10 lg:grid-cols-2 lg:gap-16">
        <Stage className="order-1 min-h-[26rem] p-6 sm:p-8">
          <div className="border-border bg-background flex h-full flex-col overflow-hidden rounded-sm border shadow-md">
            <div className="border-border text-muted-foreground flex items-center gap-2 border-b px-4 py-2.5 font-mono text-[11px]">
              <Terminal className="size-3" />
              kortix — terminal
              <span className="text-kortix-blue ml-auto flex items-center gap-1">
                <span className="bg-kortix-blue size-1.5 animate-pulse rounded-full" />
                microVM
              </span>
            </div>
            <pre className="flex-1 overflow-auto p-4 font-mono text-[11.5px] leading-relaxed">
              {SANDBOX.terminal.map((line, i) => (
                <div
                  key={`${i}:${line}`}
                  className={cn(
                    'whitespace-pre',
                    line.startsWith('$')
                      ? 'text-foreground'
                      : line.startsWith('✓')
                        ? 'text-kortix-green'
                        : line.startsWith('→')
                          ? 'text-kortix-blue'
                          : 'text-muted-foreground',
                  )}
                >
                  {line || ' '}
                </div>
              ))}
            </pre>
          </div>
        </Stage>

        <div className="order-2">
          <Eyebrow>{SANDBOX.eyebrow}</Eyebrow>
          <Heading lines={SANDBOX.heading} className="mt-6" />
          <Lead className="mt-6">{SANDBOX.description}</Lead>
          <div className="mt-10">
            {SANDBOX.bullets.map((b) => (
              <LedeBullet key={b.lede} lede={b.lede} rest={b.rest} />
            ))}
          </div>
        </div>
      </div>
    </Section>
  );
}
