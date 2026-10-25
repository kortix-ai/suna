import { Slot } from '@radix-ui/react-slot';
import { type ComponentProps } from 'react';

import { cn } from '@/lib/utils';

const SIZES = {
  sm: 'h-9 px-4 text-xs',
  md: 'h-10 px-6 text-sm',
  lg: 'h-12 px-6 text-base',
} as const;

export type MarketingButtonProps = ComponentProps<'button'> & {
  /** `primary` is the lit grey button, `secondary` the dark one with a hairline edge. */
  variant?: 'primary' | 'secondary';
  size?: keyof typeof SIZES;
  /** Render the child (a `Link`, an `a`) with the button's look. */
  asChild?: boolean;
};

/**
 * The marketing button, after Buio's dimensional button. The gradient, edge,
 * hover swap and press scale live in the `kx-button` class in globals.css;
 * this file only picks the variant and the size.
 *
 * Sizes: `sm` is for the navbar only. Every in-page button is `size="md"`
 * plus `className="hit-area-y-1"`, which grows its tap target to about 44px
 * without changing how it looks.
 */
export function MarketingButton({
  variant = 'primary',
  size = 'sm',
  asChild = false,
  className,
  ...props
}: MarketingButtonProps) {
  const Comp = asChild ? Slot : 'button';
  return (
    <Comp
      data-variant={variant}
      className={cn(
        'kx-button inline-flex shrink-0 items-center justify-center gap-2 rounded-sm font-medium whitespace-nowrap select-none',
        'outline-ring focus-visible:outline-2 focus-visible:outline-offset-2',
        'disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0',
        SIZES[size],
        className,
      )}
      {...props}
    />
  );
}
