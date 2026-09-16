import { TextClassContext } from '@/components/ui/text';
import type { AppIcon, AppIconProps } from '@/lib/icons';
import { cn } from '@/lib/utils/index';
import { cssInterop } from 'nativewind';
import * as React from 'react';
import { StyleSheet, type TextStyle } from 'react-native';

type IconProps = AppIconProps & {
  as: AppIcon;
  className?: string;
};

function IconImpl({ as: IconComponent, color, style, ...props }: IconProps) {
  // Phosphor fills with the `color` prop and ignores `style.color`, so the
  // className color (`text-*`) is read from the style here. An explicit
  // `color` prop still wins, the same precedence lucide had.
  const styleColor = (StyleSheet.flatten(style) as TextStyle | undefined)?.color;
  return (
    <IconComponent
      color={color ?? (typeof styleColor === 'string' ? styleColor : undefined)}
      style={style}
      {...props}
    />
  );
}

cssInterop(IconImpl, {
  className: {
    target: 'style',
    nativeStyleToProp: {
      height: 'size',
      width: 'size',
    },
  },
});

/**
 * Renders an app icon from `@/lib/icons` with Nativewind `className` support.
 *
 * `text-*` classes set the icon color; `size-*` / `h-*` / `w-*` set its size.
 * Never pass `weight` — `DEFAULT_ICON_WEIGHT` applies app-wide. The only
 * override is `weight="fill"` for a solid glyph.
 *
 * @example
 * ```tsx
 * import { ArrowRightIcon } from '@/lib/icons';
 * import { Icon } from '@/components/ui/icon';
 *
 * <Icon as={ArrowRightIcon} className="text-muted-foreground" size={16} />
 * ```
 */
function Icon({ as: IconComponent, className, size = 14, ...props }: IconProps) {
  const textClass = React.useContext(TextClassContext);
  return (
    <IconImpl
      as={IconComponent}
      className={cn('text-foreground', textClass, className)}
      size={size}
      {...props}
    />
  );
}

export { Icon };
