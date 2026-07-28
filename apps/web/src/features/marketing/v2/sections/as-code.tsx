'use client';

import { AS_CODE } from '@/features/marketing/v2/content';
import { Stage } from '@/features/marketing/v2/illustrations';
import { CheckLine, Eyebrow, Heading, Lead, Section } from '@/features/marketing/v2/primitives';
import { cn } from '@/lib/utils';
import { ChevronDown, File, Folder } from 'lucide-react';

/** Your whole company, as files — the repo explorer. */
export function AsCodeSection() {
  return (
    <Section id="company-as-code">
      <div className="grid gap-10 lg:grid-cols-2 lg:gap-16">
        <div>
          <Eyebrow>{AS_CODE.eyebrow}</Eyebrow>
          <Heading lines={AS_CODE.heading} className="mt-6" />
          <Lead className="mt-6">{AS_CODE.description}</Lead>
          <div className="mt-8 space-y-4">
            {AS_CODE.bullets.map((bullet) => (
              <CheckLine key={bullet}>{bullet}</CheckLine>
            ))}
          </div>
        </div>

        <Stage className="min-h-[26rem] p-4 sm:p-6">
          <div className="border-border bg-background grid h-full overflow-hidden rounded-sm border sm:grid-cols-[13rem_1fr]">
            {/* tree */}
            <div className="border-border border-b p-3 sm:border-r sm:border-b-0">
              <p className="text-muted-foreground mb-2 px-1.5 font-mono text-[11px]">acme-ops</p>
              {AS_CODE.tree.map((node) => (
                <div
                  key={node.name}
                  className={cn(
                    'flex items-center gap-1.5 rounded-sm px-1.5 py-1 font-mono text-[12px]',
                    node.accent ? 'bg-accent text-foreground' : 'text-muted-foreground',
                  )}
                  style={{ paddingLeft: `${0.375 + (node.depth ?? 0) * 0.9}rem` }}
                >
                  {node.kind === 'dir' ? (
                    <Folder className="text-kortix-blue size-3 shrink-0" />
                  ) : (
                    <File className="size-3 shrink-0" />
                  )}
                  {node.name}
                </div>
              ))}
            </div>

            {/* file */}
            <div className="min-w-0">
              <div className="border-border text-muted-foreground flex items-center gap-2 border-b px-4 py-2.5 font-mono text-[11px]">
                {AS_CODE.file.name}
                <ChevronDown className="size-3" />
                <span className="bg-kortix-green/15 text-kortix-green ml-auto rounded-sm px-1.5 py-0.5 text-[10px]">
                  on main
                </span>
              </div>
              <pre className="overflow-x-auto p-4 font-mono text-[12px] leading-relaxed">
                {AS_CODE.file.lines.map((line, i) => (
                  <div key={`${i}:${line}`} className="whitespace-pre">
                    <span className="text-muted-foreground/40 mr-4 inline-block w-4 text-right select-none">
                      {i + 1}
                    </span>
                    <span
                      className={
                        line.trimStart().startsWith('-')
                          ? 'text-kortix-blue'
                          : line.endsWith(':')
                            ? 'text-foreground font-medium'
                            : 'text-muted-foreground'
                      }
                    >
                      {line || ' '}
                    </span>
                  </div>
                ))}
              </pre>
            </div>
          </div>
        </Stage>
      </div>
    </Section>
  );
}
