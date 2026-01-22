import * as React from 'react';
import { View, Platform, Pressable } from 'react-native';
import * as TabsPrimitive from '@rn-primitives/tabs';
import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import { useColorScheme } from 'nativewind';
import { Text } from './text';
import { cn } from '@/lib/utils/utils';

const Tabs = TabsPrimitive.Root;

const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';

  if (isLiquidGlassAvailable() && Platform.OS === 'ios') {
    return (
      <TabsPrimitive.List
        ref={ref}
        className={cn('flex-row gap-2 web:inline-flex', className)}
        {...props}
      />
    );
  }

  return (
    <TabsPrimitive.List
      ref={ref}
      className={cn(
        'flex-row gap-2 web:inline-flex',
        className
      )}
      {...props}
    />
  );
});
TabsList.displayName = TabsPrimitive.List.displayName;

const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, children, ...props }, ref) => {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const { value: currentValue } = TabsPrimitive.useRootContext();
  const isActive = currentValue === props.value;

  // Render content wrapper for consistent styling
  const renderContent = () => {
    const content = typeof children === 'string' ? (
      <Text className={cn(
        'text-xs font-roobert-medium',
        isActive ? 'text-foreground' : 'text-muted-foreground'
      )}>
        {children}
      </Text>
    ) : (
      <Text className={cn(
        'text-xs font-roobert-medium',
        isActive ? 'text-foreground' : 'text-muted-foreground'
      )}>
        {children as React.ReactNode}
      </Text>
    );

    if (isLiquidGlassAvailable() && Platform.OS === 'ios') {
      return (
        <GlassView
          glassEffectStyle="regular"
          tintColor={isDark ? 'rgba(255, 255, 255, 0.05)' : 'rgba(0, 0, 0, 0.03)'}
          isInteractive
          style={{
            paddingHorizontal: 12,
            paddingVertical: 6,
            borderRadius: 12,
            borderWidth: 0.5,
            borderColor: isActive
              ? (isDark ? 'rgba(255, 255, 255, 0.2)' : 'rgba(0, 0, 0, 0.15)')
              : (isDark ? 'rgba(255, 255, 255, 0.12)' : 'rgba(0, 0, 0, 0.05)'),
            opacity: isActive ? 1 : 0.7,
          }}
        >
          {content}
        </GlassView>
      );
    }

    return content;
  };

  return (
    <TabsPrimitive.Trigger
      ref={ref}
      className={cn(
        'web:inline-flex web:items-center web:justify-center',
        !isLiquidGlassAvailable() && 'px-3 py-1.5 rounded-xl',
        !isLiquidGlassAvailable() && (isActive ? 'bg-muted' : 'bg-muted/50'),
        className
      )}
      {...props}
    >
      {renderContent()}
    </TabsPrimitive.Trigger>
  );
});
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName;

const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    className={cn('web:mt-2', className)}
    {...props}
  />
));
TabsContent.displayName = TabsPrimitive.Content.displayName;

export { Tabs, TabsList, TabsTrigger, TabsContent };
