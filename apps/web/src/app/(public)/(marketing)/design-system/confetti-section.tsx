'use client';

/**
 * `IdentityConfetti` — the burst made of ONE workspace's own icon.
 *
 * This section exists because the feature's only production trigger is the
 * last step of project onboarding (`components/projects/onboarding/steps/
 * done-step.tsx`), which a person sees once per workspace they create. Without
 * a demo, reviewing a change to the particle geometry would mean creating a
 * workspace. Here it is three clicks.
 *
 * The three rows are the three faces, in `EntityAvatar`'s own precedence
 * order — glyph, emoji, initial — and each row's tile is rendered by
 * `EntityAvatar` from the SAME props the confetti is given. That is the point
 * of the demo: the tile and the particles have to look like the same thing.
 */

import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { EntityAvatar } from '@/components/ui/entity-avatar';
import { IdentityConfetti } from '@/components/ui/identity-confetti';

const SAMPLES = [
  {
    id: 'glyph',
    name: 'Launch Control',
    glyph: { name: 'Rocket', color: 'purple' },
    emoji: null,
    face: 'Glyph — the chosen icon, in the chosen colour',
  },
  {
    id: 'emoji',
    name: 'Turtle Shop',
    glyph: null,
    emoji: '🐢',
    face: 'Emoji — thrown exactly as it is stored',
  },
  {
    id: 'initial',
    name: 'Atlas',
    glyph: null,
    emoji: null,
    face: 'Neither — the chalk initial tile, hashed from the name',
  },
] as const;

export function ConfettiSection() {
  // The burst fires on mount, so a repeat needs a new mount. One counter per
  // row, used as the `key` — no imperative handle to hold, and no way for two
  // rows to interfere with each other's burst.
  const [bursts, setBursts] = useState<Record<string, number>>({});

  return (
    <div>
      <p className="text-muted-foreground mb-6 text-base leading-relaxed">
        A celebration should be about the thing being celebrated. This burst is made of the
        workspace&apos;s own icon — its glyph in its own colour, its emoji as-is, or the chalk
        initial tile it wears when it has neither. The precedence is EntityAvatar&apos;s, extracted
        into src/lib/confetti-identity.ts, so the particles can never show a face the tile does not.
      </p>

      <div className="space-y-2">
        {SAMPLES.map((sample) => (
          <div
            key={sample.id}
            className="border-border bg-popover flex items-center gap-3 rounded-md border px-4 py-3"
          >
            <EntityAvatar label={sample.name} emoji={sample.emoji} glyph={sample.glyph} />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{sample.name}</p>
              <p className="text-muted-foreground text-xs">{sample.face}</p>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="duration-normal shrink-0 transition-colors active:scale-[0.96]"
              onClick={() =>
                setBursts((current) => ({ ...current, [sample.id]: (current[sample.id] ?? 0) + 1 }))
              }
            >
              Throw it
            </Button>
            {bursts[sample.id] ? (
              <IdentityConfetti
                key={bursts[sample.id]}
                label={sample.name}
                emoji={sample.emoji}
                glyph={sample.glyph}
              />
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
