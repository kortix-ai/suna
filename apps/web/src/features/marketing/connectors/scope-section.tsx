'use client';

import { Reveal } from '@/components/home/reveal';
import { cn } from '@/lib/utils';
import { scope } from './content';
import { Eyebrow, Section, SectionHeader } from './shared';

/**
 * The three axes of reach, next to the file that sets them. The snippet is real
 * `kortix.yaml` — people copy what they see on a marketing page, so it has to
 * parse.
 */
export function ScopeSection() {
  return (
    <Section id="scope">
      <SectionHeader eyebrow={scope.eyebrow} title={scope.title} sub={scope.sub} />

      <div className="mt-10 grid grid-cols-1 gap-4 lg:grid-cols-12">
        <Reveal delay={0.06} className="lg:col-span-7">
          <div className="border-border h-full overflow-hidden rounded-sm border">
            {scope.layers.map((layer, i) => (
              <div key={layer.id} className={cn('p-6 sm:p-8', i > 0 && 'border-border border-t')}>
                <Eyebrow>{layer.label}</Eyebrow>
                <p className="text-muted-foreground mt-3 text-sm leading-relaxed">{layer.body}</p>
              </div>
            ))}
          </div>
        </Reveal>

        <Reveal delay={0.1} className="lg:col-span-5">
          <div className="border-border bg-card flex h-full flex-col overflow-hidden rounded-sm border">
            <div className="border-border border-b px-5 py-3">
              <Eyebrow>{scope.codeCaption}</Eyebrow>
            </div>
            <pre className="text-foreground overflow-x-auto px-5 py-5 font-mono text-[12px] leading-relaxed">
              <code>{scope.code}</code>
            </pre>
            <p className="border-border text-muted-foreground mt-auto border-t px-5 py-4 text-sm leading-relaxed">
              {scope.codeNote}
            </p>
          </div>
        </Reveal>
      </div>
    </Section>
  );
}
