import type { ReactNode } from 'react';
import { credentials } from './content';

/**
 * The path a credential takes, end to end, as five numbered stops on one rail.
 * The point of drawing it rather than listing it is the shape: the value moves
 * from the store into the machine and is destroyed with it, and never turns
 * back toward the model.
 *
 * The rail is one absolutely-positioned hairline behind the row of dots, so it
 * lands on a single pixel at every width instead of being stitched together
 * from per-cell borders. Below `sm` the stops stack and the rail is dropped —
 * a vertical rail through wrapped body copy reads as noise, not as a flow.
 */
export function CredentialFlow(): ReactNode {
  return (
    <div className="border-border bg-card rounded-sm border p-5 sm:p-8">
      <div className="relative">
        {/* centre of the 8px dot, so the rail and every stop line up */}
        <span
          aria-hidden
          className="bg-border absolute top-[3.5px] right-0 left-0 hidden h-px sm:block"
        />

        <ol className="relative grid gap-6 sm:grid-cols-5 sm:gap-5">
          {credentials.flow.map((step) => (
            <li key={step.n} className="flex flex-col">
              <span className="bg-card flex items-center sm:pr-4">
                <span aria-hidden className="bg-foreground size-2 shrink-0 rounded-full" />
              </span>
              <p className="text-muted-foreground/45 mt-4 font-mono text-[10px] tracking-widest tabular-nums">
                {step.n}
              </p>
              <h3 className="text-foreground mt-1.5 text-sm leading-tight font-medium">
                {step.k}
              </h3>
              <p className="text-muted-foreground mt-2 text-[13px] leading-relaxed">{step.v}</p>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
