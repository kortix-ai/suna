'use client';

import { Reveal } from '@/components/home/reveal';
import SectionHeader from '@/features/marketing/component/section-header';
import { cn } from '@/lib/utils';
import { connect } from './content';
import { Eyebrow, ProductShot, Section } from './shared';

/**
 * The three ways a tool becomes a connector, then the real catalogue screen.
 * The screenshot is the point of this section — the claim "3,000+ apps in a
 * click" is worth nothing next to a mock, and worth a lot next to the actual UI.
 */
export function ConnectSection() {
  return (
    <Section id="connect">
      <SectionHeader eyebrow={connect.eyebrow} title={connect.title} description={connect.sub} />

      <Reveal delay={0.06}>
        <div className="border-border mt-10 grid overflow-hidden rounded-sm border sm:grid-cols-3">
          {connect.routes.map((route, i) => (
            <article
              key={route.id}
              className={cn(
                'p-6 sm:p-8',
                i > 0 && 'border-border border-t sm:border-t-0 sm:border-l',
              )}
            >
              <Eyebrow>{route.label}</Eyebrow>
              <h3 className="text-foreground mt-4 text-lg leading-tight font-medium tracking-tight">
                {route.title}
              </h3>
              <p className="text-muted-foreground mt-3 text-sm leading-relaxed">{route.body}</p>
            </article>
          ))}
        </div>
      </Reveal>

      <Reveal delay={0.1}>
        <ProductShot
          src={connect.shot.src}
          alt={connect.shot.alt}
          caption={connect.shot.caption}
          priority
        />
      </Reveal>
    </Section>
  );
}
