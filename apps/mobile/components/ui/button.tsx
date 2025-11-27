import { TextClassContext } from '@/components/ui/text';
import { cn } from '@/lib/utils';
import { cva, type VariantProps } from 'class-variance-authority';
import { Platform, Pressable } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import * as React from 'react';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

const buttonVariants = cva(
  cn(
    'group shrink-0 flex-row items-center justify-center gap-2 rounded-2xl shadow-none',
    Platform.select({
      web: "focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive whitespace-nowrap outline-none transition-all focus-visible:ring-[3px] disabled:pointer-events-none [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
    })
  ),
  {
    variants: {
      variant: {
        default: cn(
          'bg-primary active:bg-primary/90 shadow-sm shadow-black/5',
          Platform.select({ web: 'hover:bg-primary/90' })
        ),
        destructive: cn(
          'bg-destructive active:bg-destructive/90 dark:bg-destructive/60 shadow-sm shadow-black/5',
          Platform.select({
            web: 'hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40',
          })
        ),
        outline: cn(
          'border-[1px] border-border bg-card active:bg-accent dark:bg-card dark:border-border dark:active:bg-input/50 shadow-sm shadow-black/5',
          Platform.select({
            web: 'hover:bg-accent dark:hover:bg-input/50',
          })
        ),
        secondary: cn(
          'bg-secondary active:bg-secondary/80 shadow-sm shadow-black/5',
          Platform.select({ web: 'hover:bg-secondary/80' })
        ),
        ghost: cn(
          'active:bg-accent dark:active:bg-accent/50',
          Platform.select({ web: 'hover:bg-accent dark:hover:bg-accent/50' })
        ),
        link: '',
      },
      size: {
        default: 'h-12 rounded-2xl px-4', // Standard mobile button: 48px height, 16px radius
        sm: 'h-9 rounded-2xl px-3 gap-1.5', // Small button: 36px height
        lg: 'h-14 rounded-2xl px-6', // Large button: 56px height (for forms/emphasis)
        icon: 'h-12 w-12 rounded-2xl', // Icon button: 48px square
        figma: 'h-12 rounded-2xl px-4 gap-[6px]', // Alias for default (kept for compatibility)
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
);

const buttonTextVariants = cva(
  cn(
    'text-foreground font-roobert-medium',
    Platform.select({ web: 'pointer-events-none transition-colors' })
  ),
  {
    variants: {
      variant: {
        default: 'text-primary-foreground',
        destructive: 'text-white',
        outline: cn(
          'group-active:text-accent-foreground',
          Platform.select({ web: 'group-hover:text-accent-foreground' })
        ),
        secondary: 'text-secondary-foreground',
        ghost: 'group-active:text-accent-foreground',
        link: cn(
          'text-primary group-active:underline',
          Platform.select({ web: 'underline-offset-4 hover:underline group-hover:underline' })
        ),
      },
      size: {
        default: 'text-[15px]', // 15px text for standard buttons (matches app style)
        sm: 'text-sm', // 14px for small buttons
        lg: 'text-[16px]', // 16px for large buttons
        figma: 'text-[16px]', // Alias for lg (kept for compatibility)
        icon: '', // No text for icon-only buttons
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
);

type ButtonProps = React.ComponentProps<typeof Pressable> &
  React.RefAttributes<typeof Pressable> &
  VariantProps<typeof buttonVariants>;

function Button({ className, variant, size, onPressIn, onPressOut, ...props }: ButtonProps) {
  const scale = useSharedValue(1);
  const opacity = useSharedValue(1);
  
  // Initialize opacity based on disabled state
  React.useEffect(() => {
    opacity.value = props.disabled ? 0.5 : 1;
  }, [props.disabled, opacity]);
  
  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
    opacity: opacity.value,
  }));

  const handlePressIn = (e: any) => {
    if (!props.disabled) {
      scale.value = withSpring(0.98, { damping: 15, stiffness: 400 });
    }
    onPressIn?.(e);
  };

  const handlePressOut = (e: any) => {
    scale.value = withSpring(1, { damping: 15, stiffness: 400 });
    onPressOut?.(e);
  };

  return (
    <TextClassContext.Provider value={buttonTextVariants({ variant, size })}>
      <AnimatedPressable
        className={cn(buttonVariants({ variant, size }), className)}
        role="button"
        style={animatedStyle}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        {...props}
      />
    </TextClassContext.Provider>
  );
}

export { Button, buttonTextVariants, buttonVariants };
export type { ButtonProps };
