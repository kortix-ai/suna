'use client';

import { TRUST } from './narrative';

export function TrustStrip() {
  return (
    <div className="border-border/60 border-y">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-center gap-x-6 gap-y-3 px-6 py-5 lg:px-0">
        <span className="text-foreground text-sm font-medium">{TRUST.lead}</span>
        <span className="bg-border hidden h-4 w-px sm:block" />
        <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2">
          {TRUST.chips.map((c) => (
            <span
              key={c}
              className="text-muted-foreground inline-flex items-center gap-1.5 text-xs font-medium"
            >
              <span className="bg-kortix-green size-1.5 rounded-full" />
              {c}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
