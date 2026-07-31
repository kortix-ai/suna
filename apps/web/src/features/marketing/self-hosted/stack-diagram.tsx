import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';
import { stack } from './content';

/**
 * The self-host stack drawn as what it is: one box with one Compose project
 * inside it. Each group is a band of services, each service is its real Compose
 * name in mono next to a plain-English gloss.
 *
 * Built from divs rather than an image so the service names stay copy-pasteable
 * and legible at any width — someone reading this page is about to type them
 * into `kortix self-host logs`.
 */
export function StackDiagram(): ReactNode {
  return (
    <div className="border-border bg-card overflow-hidden rounded-sm border">
      <div className="border-border flex items-center gap-3 border-b px-5 py-3.5 sm:px-7">
        <span className="text-muted-foreground font-mono text-[10px] tracking-widest uppercase">
          one host
        </span>
        <span aria-hidden className="bg-border h-px flex-1" />
        <span className="text-muted-foreground/60 font-mono text-[10px] tracking-widest">
          docker compose
        </span>
      </div>

      {stack.groups.map((group, g) => (
        <section key={group.id} className={cn('border-border', g > 0 && 'border-t')}>
          <p className="text-muted-foreground/60 px-5 pt-5 font-mono text-[10px] tracking-widest uppercase sm:px-7">
            {group.label}
          </p>
          <ul className="grid px-5 pt-3 pb-5 sm:grid-cols-2 sm:px-7 lg:grid-cols-3">
            {group.services.map((service) => (
              <li key={service.k} className="flex flex-col py-2.5 pr-6">
                <span className="text-foreground font-mono text-[12.5px]">{service.k}</span>
                <span className="text-muted-foreground/70 mt-1 text-[11.5px] leading-relaxed">
                  {service.v}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
