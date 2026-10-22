import { Avatar as AvatarRoot, AvatarFallback } from '@/components/ui/avatar';
import { entityChalk } from '@/lib/ui/entity-chalk';
import * as React from 'react';
import { Text, type ViewProps } from 'react-native';

interface AvatarProps extends ViewProps {
  /** Size of the avatar container (default: 48) */
  size?: number;

  /** Fallback text (first letter shown) */
  fallbackText?: string;

  /**
   * Colour the tile from `fallbackText` with the shared `chalkColors` (via
   * `entityChalk`): the project and account tile, the same colours web's
   * `EntityAvatar` gives the same name. Draws a 1px border, like web.
   */
  chalk?: boolean;
}

/**
 * Avatar — the chalk tile every list and page header shows for a project or
 * account: a rounded square in the name's chalk colour, the first letter of
 * `fallbackText` centered, a 1px border, `style` overriding any of it.
 *
 * Built on the RNR `Avatar` / `AvatarFallback` primitives from
 * `@/components/ui/avatar`.
 */
export function Avatar({ size = 48, fallbackText, chalk = false, style, ...props }: AvatarProps) {
  const borderRadius = Math.round(size * 0.32); // 32% for slightly softer corners
  const colors = chalk ? chalkDefaults(fallbackText) : { bg: undefined, icon: undefined, border: undefined };

  return (
    <AvatarRoot
      alt={fallbackText ?? 'avatar'}
      className="items-center justify-center overflow-hidden"
      style={[
        {
          width: size,
          height: size,
          backgroundColor: colors.bg,
          borderRadius: borderRadius,
          borderWidth: 1,
          borderColor: colors.border,
        },
        style,
      ]}
      {...props}
    >
      <AvatarFallback className="bg-transparent">
        {fallbackText ? (
          <Text
            style={{
              color: colors.icon,
              fontSize: size * 0.4,
              fontWeight: '600',
            }}
          >
            {(fallbackText.trim().charAt(0) || '?').toUpperCase()}
          </Text>
        ) : null}
      </AvatarFallback>
    </AvatarRoot>
  );
}

function chalkDefaults(name: string | undefined) {
  const colors = entityChalk(name);
  return { bg: colors.background, icon: colors.foreground, border: colors.border };
}
