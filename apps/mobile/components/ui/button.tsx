import { TextClassContext } from '@/components/ui/text';
import { cn } from '@/lib/utils';
import { cva, type VariantProps } from 'class-variance-authority';
import { Platform, Pressable } from 'react-native';

const buttonVariants = cva(
  cn(
    'group shrink-0 flex-row items-center justify-center gap-2 rounded-full shadow-none',
    Platform.select({
      web: "aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive whitespace-nowrap outline-none transition-all focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
    })
  ),
  {
    variants: {
      variant: {
        default: cn(
          'bg-primary shadow-sm shadow-black/5 active:bg-primary/90',
          Platform.select({ web: 'hover:bg-primary/90' })
        ),
        destructive: cn(
          'bg-destructive shadow-sm shadow-black/5 active:bg-destructive/90 dark:bg-destructive/60',
          Platform.select({
            web: 'hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40',
          })
        ),
        outline: cn(
          'border border-border bg-transparent shadow-sm shadow-black/5 active:bg-accent dark:active:bg-input/50',
          Platform.select({
            web: 'hover:bg-accent dark:hover:bg-input/50',
          })
        ),
        'secondary-outline': cn(
          'border border-primary/5 bg-secondary shadow-sm shadow-black/5 active:bg-secondary/80',
          Platform.select({
            web: 'hover:bg-secondary/80',
          })
        ),
        secondary: cn(
          'bg-secondary shadow-sm shadow-black/5 active:bg-secondary/80',
          Platform.select({ web: 'hover:bg-secondary/80' })
        ),
        ghost: cn(
          'active:bg-accent dark:active:bg-accent/50',
          Platform.select({ web: 'hover:bg-accent dark:hover:bg-accent/50' })
        ),
        accent: cn(
          'bg-accent shadow-sm shadow-black/5 active:bg-accent/80',
          Platform.select({ web: 'hover:bg-accent/80' })
        ),
        card: cn(
          'bg-card shadow-sm shadow-black/5 active:bg-card/80',
          Platform.select({ web: 'hover:bg-card/80' })
        ),
        link: '',
        inverted: cn(
          'bg-foreground shadow-sm shadow-black/5 active:bg-foreground/90',
          Platform.select({ web: 'hover:bg-foreground/90' })
        ),
        white: 'bg-white text-black shadow-sm shadow-black/5 active:bg-white/90',
        black: 'bg-black text-white shadow-sm shadow-black/5 active:bg-black/90',
        transparent: 'bg-transparent',
      },
      size: {
        default: cn('h-10 px-4 py-2 sm:h-9', Platform.select({ web: 'has-[>svg]:px-3' })),
        sm: cn('h-9 gap-1.5 px-3 sm:h-8', Platform.select({ web: 'has-[>svg]:px-2.5' })),
        lg: cn('h-11 px-6 sm:h-10', Platform.select({ web: 'has-[>svg]:px-4' })),
        icon: 'h-10 w-10 sm:h-9 sm:w-9',
      },
      content: {
        fit: 'self-center',
        'fit-lg': 'self-center px-8',
        'fit-sm': 'self-center px-4',
        'fit-icon': 'self-center px-2',
        full: 'flex w-full items-center justify-center text-center',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
      // content: "full",
    },
    compoundVariants: [
      {
        variant: 'transparent',
        size: ['default', 'sm', 'lg'],
        class: 'h-fit min-h-0 p-0 sm:h-fit',
      },
    ],
  }
);

const buttonTextVariants = cva(
  cn(
    'text-sm font-medium text-foreground',
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
        'secondary-outline': 'text-secondary-foreground',
        ghost: 'group-active:text-accent-foreground',
        accent: 'text-accent-foreground',
        card: 'text-card-foreground',
        link: cn(
          'text-primary group-active:underline',
          Platform.select({ web: 'underline-offset-4 hover:underline group-hover:underline' })
        ),
        inverted: 'text-background',
        white: 'text-black',
        black: 'text-white',
        transparent: 'text-muted-foreground',
      },
      size: {
        default: '',
        sm: '',
        lg: '',
        icon: '',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
);

type ButtonProps = React.ComponentProps<typeof Pressable> & VariantProps<typeof buttonVariants>;

function getTextClassName(className?: string) {
  return className
    ?.split(/\s+/)
    .filter((token) => token.slice(token.lastIndexOf(':') + 1).startsWith('text-'))
    .join(' ');
}

function Button({ className, variant, size, content, ...props }: ButtonProps) {
  return (
    <TextClassContext.Provider
      value={cn(buttonTextVariants({ variant, size }), getTextClassName(className))}>
      <Pressable
        className={cn(
          props.disabled && 'opacity-50',
          buttonVariants({ variant, size, content }),
          className
        )}
        role="button"
        {...props}
      />
    </TextClassContext.Provider>
  );
}

export { Button, buttonTextVariants, buttonVariants };
export type { ButtonProps };
