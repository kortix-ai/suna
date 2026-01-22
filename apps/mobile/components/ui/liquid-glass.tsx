import * as React from 'react';
import { View, ViewStyle, Platform } from 'react-native';
import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import { useColorScheme } from 'nativewind';

export interface LiquidGlassProps {
  children: React.ReactNode;
  variant?: 'default' | 'primary' | 'subtle' | 'card';
  style?: ViewStyle;
  tintColor?: string;
  borderColor?: string;
  backgroundColor?: string;
  borderWidth?: number;
  isInteractive?: boolean;
  borderRadius?: number;
  elevation?: number;
  shadow?: {
    color?: string;
    offset?: { width: number; height: number };
    opacity?: number;
    radius?: number;
  };
  forceDisableGlass?: boolean;
  className?: string;
}

function getDefaultTintColor(
  variant: LiquidGlassProps['variant'],
  colorScheme: 'dark' | 'light'
): string {
  switch (variant) {
    case 'primary':
      return 'rgba(0, 122, 255, 0.9)';
    case 'subtle':
      return colorScheme === 'dark' 
        ? 'rgba(255, 255, 255, 0.03)' 
        : 'rgba(0, 0, 0, 0.02)';
    case 'card':
      return colorScheme === 'dark' 
        ? 'rgba(255, 255, 255, 0.08)' 
        : 'rgba(0, 0, 0, 0.04)';
    case 'default':
    default:
      return colorScheme === 'dark' 
        ? 'rgba(255, 255, 255, 0.05)' 
        : 'rgba(0, 0, 0, 0.03)';
  }
}

function getDefaultBorderColor(
  variant: LiquidGlassProps['variant'],
  colorScheme: 'dark' | 'light'
): string {
  switch (variant) {
    case 'primary':
      return colorScheme === 'dark' 
        ? 'rgba(0, 122, 255, 0.3)' 
        : 'rgba(0, 122, 255, 0.2)';
    case 'subtle':
      return colorScheme === 'dark' 
        ? 'rgba(255, 255, 255, 0.05)' 
        : 'rgba(0, 0, 0, 0.03)';
    case 'card':
      return colorScheme === 'dark' 
        ? 'rgba(255, 255, 255, 0.12)' 
        : 'rgba(0, 0, 0, 0.05)';
    case 'default':
    default:
      return colorScheme === 'dark' 
        ? 'rgba(255, 255, 255, 0.12)' 
        : 'rgba(0, 0, 0, 0.05)';
  }
}

function getDefaultBackgroundColor(
  variant: LiquidGlassProps['variant'],
  colorScheme: 'dark' | 'light',
  customBg?: string
): string {
  if (customBg) return customBg;
  
  switch (variant) {
    case 'primary':
      return '#007AFF';
    case 'subtle':
      return colorScheme === 'dark' 
        ? 'rgba(255, 255, 255, 0.04)' 
        : 'rgba(0, 0, 0, 0.02)';
    case 'card':
      return colorScheme === 'dark' 
        ? 'rgba(255, 255, 255, 0.08)' 
        : 'rgba(0, 0, 0, 0.04)';
    case 'default':
    default:
      return colorScheme === 'dark' 
        ? 'rgba(255, 255, 255, 0.08)' 
        : 'rgba(0, 0, 0, 0.04)';
  }
}

export function LiquidGlass({
  children,
  variant = 'default',
  style,
  tintColor,
  borderColor,
  backgroundColor,
  borderWidth = 0.5,
  isInteractive = false,
  borderRadius,
  elevation,
  shadow,
  forceDisableGlass = false,
  className,
}: LiquidGlassProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const isIOS = Platform.OS === 'ios';
  
  const shouldUseGlass = !forceDisableGlass && 
    isLiquidGlassAvailable() && 
    (isIOS || variant === 'primary');
  
  const defaultTintColor = tintColor || getDefaultTintColor(variant, colorScheme || 'dark');
  const defaultBorderColor = borderColor || getDefaultBorderColor(variant, colorScheme || 'dark');
  const defaultBackgroundColor = getDefaultBackgroundColor(variant, colorScheme || 'dark', backgroundColor);
  
  const defaultElevation = elevation !== undefined 
    ? elevation 
    : (variant === 'card' ? 2 : 0);
  
  const fallbackStyle: ViewStyle = {
    ...style,
    backgroundColor: defaultBackgroundColor,
    borderWidth,
    borderColor: defaultBorderColor,
    ...(borderRadius !== undefined && { borderRadius }),
    ...(isIOS ? {} : {
      elevation: defaultElevation,
      ...(shadow && {
        shadowColor: shadow.color || '#000',
        shadowOffset: shadow.offset || { width: 0, height: 2 },
        shadowOpacity: shadow.opacity !== undefined ? shadow.opacity : 0.1,
        shadowRadius: shadow.radius || 4,
      }),
    }),
  };

  if (shouldUseGlass) {
    return (
      <GlassView
        glassEffectStyle="regular"
        tintColor={defaultTintColor}
        isInteractive={isInteractive}
        style={[
          {
            borderWidth,
            borderColor: defaultBorderColor,
            ...(borderRadius !== undefined && { borderRadius }),
          },
          style,
        ]}
      >
        {children}
      </GlassView>
    );
  }

  return (
    <View style={fallbackStyle} className={className}>
      {children}
    </View>
  );
}

export interface LiquidGlassButtonProps extends Omit<LiquidGlassProps, 'children'> {
  onPress?: () => void;
  disabled?: boolean;
  children: React.ReactNode;
  activeOpacity?: number;
}

export function LiquidGlassButton({
  onPress,
  disabled = false,
  activeOpacity = 0.8,
  children,
  ...glassProps
}: LiquidGlassButtonProps) {
  const { Pressable } = require('react-native');
  
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={{ opacity: disabled ? 0.5 : 1 }}
    >
      <LiquidGlass {...glassProps}>
        {children}
      </LiquidGlass>
    </Pressable>
  );
}
