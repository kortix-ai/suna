import * as React from 'react';
import { View, Text } from 'react-native';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center justify-center rounded-2xl border px-3 py-1.5 text-xs font-medium',
  {
    variants: {
      variant: {
        default:
          'border-transparent bg-primary text-primary-foreground',
        secondary:
          'border-transparent bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
        destructive:
          'border-transparent bg-destructive text-white dark:bg-destructive/60',
        outline:
          'text-foreground border-border',
        new:
          'text-purple-600 dark:text-purple-300 bg-purple-600/30 dark:bg-purple-600/30',
        beta:
          'text-blue-600 dark:text-blue-300 bg-blue-600/30 dark:bg-blue-600/30',
        highlight:
          'text-green-800 dark:text-green-300 bg-green-600/30 dark:bg-green-600/30',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

export interface BadgeProps
  extends React.ComponentProps<typeof View>,
    VariantProps<typeof badgeVariants> {
  children: React.ReactNode;
}

function Badge({ className, variant, children, ...props }: BadgeProps) {
  return (
    <View
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    >
      <Text className="text-xs font-roobert-medium">
        {children}
      </Text>
    </View>
  );
}

export { Badge, badgeVariants };

