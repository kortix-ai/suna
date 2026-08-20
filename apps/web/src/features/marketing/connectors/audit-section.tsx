'use client';

import { Reveal } from '@/components/home/reveal';
import SectionHeader from '@/features/marketing/component/section-header';
import { cn } from '@/lib/utils';
import { audit } from './content';
import { Eyebrow, Section } from './shared';

/**
 * The ledger. Every field named here is a real column on
 * `kortix.connector_calls` — do not add a field to sound thorough.
 */
export function AuditSection() {
  return (
    <Section id="audit">
      <SectionHeader eyebrow={audit.eyebrow} title={audit.title} description={audit.sub} />

      <Reveal delay={0.06}>
        <div className="border-border mt-10 grid overflow-hidden rounded-sm border sm:grid-cols-2 lg:grid-cols-3">
          {audit.fields.map((field, i) => (
            <div
              key={field.id}
              className={cn(
                'border-border p-6 sm:p-7',
                // rules only between cells, never on the outer edge
                'border-t sm:[&:nth-child(-n+2)]:border-t-0 lg:[&:nth-child(3)]:border-t-0',
                'sm:[&:nth-child(even)]:border-l lg:[&:nth-child(even)]:border-l-0',
                'lg:[&:not(:nth-child(3n+1))]:border-l',
                i === 0 && 'border-t-0',
              )}
            >
              <Eyebrow>{field.label}</Eyebrow>
              <p className="text-muted-foreground mt-3 text-sm leading-relaxed">{field.body}</p>
            </div>
          ))}
        </div>
      </Reveal>

      <Reveal delay={0.1}>
        <p className="text-muted-foreground mt-6 font-mono text-[11px] leading-relaxed">
          {audit.note}
        </p>
      </Reveal>
    </Section>
  );
}
