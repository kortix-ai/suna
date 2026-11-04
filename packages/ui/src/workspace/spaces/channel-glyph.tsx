import { HashIcon, LockSimpleIcon, type IconProps } from '@phosphor-icons/react';

/** A channel's leading glyph: `#` for a public channel, a lock for a private one (only its members see it). */
export function ChannelGlyph({ visibility, ...props }: IconProps & { visibility?: 'public' | 'private' }) {
  return visibility === 'private' ? <LockSimpleIcon {...props} /> : <HashIcon {...props} />;
}
