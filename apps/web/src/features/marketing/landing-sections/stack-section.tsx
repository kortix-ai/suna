import { Section } from '@/features/marketing/kit/section';
import { SectionHeading } from '@/features/marketing/kit/section-heading';

import { stack } from './content';

/**
 * How it works, in one section: the product as a stack of six layers, from
 * the repo to the change request that lands work back in it. The heading and
 * the starter repo stay pinned on the left from lg while the layers scroll
 * past on the right (Buio's 1/3 + 2/3 split, hairline rows).
 */
export function StackSection() {
  return (
    <Section id="how-it-works" className="grid grid-cols-1 gap-y-16 lg:grid-cols-3">
      <div className="lg:sticky lg:top-24 lg:self-start lg:pr-12">
        <SectionHeading
          title={stack.title}
          titleMuted={stack.titleMuted}
          description={stack.description}
        />
        {/* The artifact: the starter repo's real paths, as `kortix init` writes them. */}
        <ul
          aria-label="A new Kortix project"
          className="border-border text-muted-foreground mt-12 border-y py-6 font-mono text-sm"
        >
          {stack.tree.map((path) => (
            <li key={path} className="py-1">
              {path}
            </li>
          ))}
        </ul>
      </div>

      <ol className="border-border border-b lg:col-span-2">
        {stack.layers.map((layer) => (
          <li
            key={layer.id}
            className="border-border grid grid-cols-1 gap-y-2 border-t py-8 md:grid-cols-2 md:items-baseline"
          >
            <h3 className="text-foreground text-base font-medium text-pretty md:pr-8">
              {layer.title}
            </h3>
            <p className="text-muted-foreground text-sm text-pretty">{layer.description}</p>
          </li>
        ))}
      </ol>
    </Section>
  );
}
