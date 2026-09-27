import { chalkColors, type ChalkColors } from '@kortix/shared';

/**
 * The chalk colours of a project or account tile, from its name. The seed is
 * the trimmed name — the same seed `apps/web`'s `EntityAvatar` passes to
 * `chalkColors` — so one project gets the same colours on web and mobile. A
 * blank name seeds `'?'` (`chalkColors`' own fallback).
 */
export function entityChalk(name: string | null | undefined): ChalkColors {
  return chalkColors(name?.trim() ?? '');
}
