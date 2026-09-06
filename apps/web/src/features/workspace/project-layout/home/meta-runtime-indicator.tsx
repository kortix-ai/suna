'use client';

import { ShippingContainerIcon as Container } from '@phosphor-icons/react';

import Hint from '@/components/ui/hint';

/**
 * Shown in the composer toolbar while the Meta agent is selected. Meta cannot
 * take a sandbox override, so this replaces the picker rather than sitting
 * beside it — the slot says which runtime you are getting instead of offering
 * a choice that would be ignored.
 */
export function MetaRuntimeIndicator() {
  return (
    <Hint label="Meta uses a fixed minimal sandbox. It starts specialized sessions for project work.">
      <span className="text-muted-foreground inline-flex h-8 items-center gap-1.5 px-2.5 text-xs font-medium">
        <Container className="size-3.5" />
        Meta runtime
      </span>
    </Hint>
  );
}
