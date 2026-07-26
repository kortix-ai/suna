'use client';

/**
 * The proposal — "Narrative, with the full history one click away".
 *
 * This is not a fourth design. It is the product decision that A and C are the
 * same product at two settings, expressed as code:
 *
 *   detail = 'narrative'  →  Variant C. The ask, the answer, the deliverable.
 *   detail = 'full'       →  Variant A. Every run of work, folded to one human
 *                            line, raw command still one more click down.
 *
 * Because both readings are built from the same `buildActivityItems` model, the
 * toggle is a pure re-render of the same data — not a different screen, not a
 * different route, and not a mode the reader has to go and find in settings.
 * The per-turn work line still expands on its own; this is the "show me
 * everything, everywhere" affordance layered above it.
 */

import { cn } from '@/lib/utils';
import { ChatDetailToggle, useChatDetail } from '../chat-detail';
import type { ChatVariantProps } from './types';
import { VariantGrouped } from './variant-grouped';
import { VariantNarrative } from './variant-narrative';

export function VariantAdaptive(props: ChatVariantProps) {
  const { detail } = useChatDetail();
  const showingFull = detail === 'full';

  return (
    <div className="flex flex-col">
      {/* The control sits with the transcript, not in a settings panel — the
          decision to see more is made while reading, so it belongs where the
          reading happens. Right-aligned and quiet so it never competes with
          the first user message for attention. */}
      <div className="mb-2 flex justify-end">
        <ChatDetailToggle />
      </div>

      <div
        className={cn(
          // Full history is denser by nature; give it a touch less breathing
          // room so a long session stays scannable rather than endless.
          showingFull ? 'text-[13px]' : '',
        )}
      >
        {showingFull ? <VariantGrouped {...props} /> : <VariantNarrative {...props} />}
      </div>
    </div>
  );
}
