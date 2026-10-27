import type { ReactNode } from 'react';

import { DitherField } from '../kit/dither-field';

/**
 * The hero stage of a surface page (/desktop, /mobile, /cli, /slack, /teams):
 * the site's still dither field on the card surface, with the product rising
 * from the bottom edge. Same field as `ExchangeVisual`, so the surface pages read as one family with
 * /security and /self-hosted. Static: no motion, nothing to pay for.
 */
export function Stage({ device }: { device: ReactNode }) {
  return (
    <div className="bg-card relative flex h-[26rem] items-end justify-center overflow-hidden px-6 pt-12 sm:h-[32rem] lg:h-[36rem]">
      <div aria-hidden className="text-foreground pointer-events-none absolute inset-0 opacity-40">
        <DitherField still />
      </div>
      <div className="relative flex w-full justify-center">{device}</div>
    </div>
  );
}
