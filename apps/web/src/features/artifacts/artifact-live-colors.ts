import type { ArtifactLiveColor } from '@kortix/sdk';

/**
 * A participant's color, as literal `kortix-*` classes (Tailwind reads them
 * from this file). The color is identity, never status: it paints a caret
 * line, a ring, a glyph or the `/15` tint of a selection. Names stay ink.
 */
export const LIVE_FILL: Record<ArtifactLiveColor, string> = {
  blue: 'bg-kortix-blue',
  green: 'bg-kortix-green',
  orange: 'bg-kortix-orange',
  purple: 'bg-kortix-purple',
  red: 'bg-kortix-red',
};

export const LIVE_BORDER: Record<ArtifactLiveColor, string> = {
  blue: 'border-kortix-blue',
  green: 'border-kortix-green',
  orange: 'border-kortix-orange',
  purple: 'border-kortix-purple',
  red: 'border-kortix-red',
};

export const LIVE_TINT: Record<ArtifactLiveColor, string> = {
  blue: 'bg-kortix-blue/15',
  green: 'bg-kortix-green/15',
  orange: 'bg-kortix-orange/15',
  purple: 'bg-kortix-purple/15',
  red: 'bg-kortix-red/15',
};

export const LIVE_RING: Record<ArtifactLiveColor, string> = {
  blue: 'ring-kortix-blue',
  green: 'ring-kortix-green',
  orange: 'ring-kortix-orange',
  purple: 'ring-kortix-purple',
  red: 'ring-kortix-red',
};

export const LIVE_TEXT: Record<ArtifactLiveColor, string> = {
  blue: 'text-kortix-blue',
  green: 'text-kortix-green',
  orange: 'text-kortix-orange',
  purple: 'text-kortix-purple',
  red: 'text-kortix-red',
};
