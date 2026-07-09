// apps/mobile/components/ui/card.tsx
import * as React from 'react';
import { View, type ViewProps } from 'react-native';
import { Text } from './text';
import { cn } from '@/lib/utils/utils';

export function Card({ className, ...props }: ViewProps & { className?: string }) {
  return <View className={cn('rounded-lg bg-card border-[1.5px] border-border p-4', className)} {...props} />;
}
export function CardHeader({ className, ...props }: ViewProps & { className?: string }) {
  return <View className={cn('gap-1.5 mb-3', className)} {...props} />;
}
export function CardTitle({ className, ...props }: React.ComponentProps<typeof Text>) {
  return <Text className={cn('font-roobert-semibold text-base text-foreground', className)} {...props} />;
}
export function CardContent({ className, ...props }: ViewProps & { className?: string }) {
  return <View className={cn('gap-2', className)} {...props} />;
}
export function CardFooter({ className, ...props }: ViewProps & { className?: string }) {
  return <View className={cn('flex-row items-center mt-3', className)} {...props} />;
}
