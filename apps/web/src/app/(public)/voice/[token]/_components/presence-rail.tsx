'use client';

import { EntityAvatar } from '@/components/ui/entity-avatar';
import { IconMicOff, IconUser } from '@/components/ui/kortix-icons';
import { cn } from '@/lib/utils';

import type { PresenceEntry } from './types';

/**
 * Who's in the call. Audio-only, so this is deliberately built as a row of
 * initials/icon tiles (not blank video rects standing in for cameras that
 * don't exist) — the agent gets the Kortix mark, the human gets a plain
 * person glyph, and whoever is talking right now gets a highlighted tile.
 */
export function PresenceRail({ roster }: { roster: PresenceEntry[] }) {
  if (roster.length === 0) return null;

  return (
    <div
      className="flex flex-wrap items-start justify-center gap-5 py-1 sm:gap-6"
      aria-label="Participants"
    >
      {roster.map((entry) => (
        <PresenceTile key={entry.identity} entry={entry} />
      ))}
    </div>
  );
}

function PresenceTile({ entry }: { entry: PresenceEntry }) {
  return (
    <div className="flex w-16 flex-col items-center gap-1.5">
      <div
        className={cn(
          'rounded-md p-0.5 transition-shadow duration-200',
          entry.speaking &&
            'smooth-shadow-md shadow-kortix-green/20 outline-2 outline-offset-2 outline-kortix-green',
        )}
      >
        <div className="relative">
          {entry.isAgent ? (
            <EntityAvatar label="Kortix" size="xl" className="bg-foreground text-background" />
          ) : (
            <EntityAvatar label={entry.name} icon={IconUser} size="xl" />
          )}
          {!entry.isAgent && !entry.micEnabled && (
            <span
              className="border-background bg-destructive text-background absolute -right-1 -bottom-1 flex size-5 items-center justify-center rounded-full border-2"
              aria-label="Microphone muted"
            >
              <IconMicOff className="size-2.5" strokeWidth={2.5} />
            </span>
          )}
        </div>
      </div>
      <span className="text-foreground max-w-16 truncate text-xs font-medium">{entry.name}</span>
    </div>
  );
}
