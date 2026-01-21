import * as React from 'react';
import { View, type ViewProps, type ViewStyle } from 'react-native';
import { useColorScheme } from 'nativewind';
import SprintLabSymbolBlack from '@/assets/brand/kortix-symbol.svg';
import SprintLabSymbolWhite from '@/assets/brand/Symbol.svg';
import LogomarkBlack from '@/assets/brand/Logomark-Black.svg';
import LogomarkWhite from '@/assets/brand/Logomark-White.svg';

interface SprintLabLogoProps extends Omit<ViewProps, 'style'> {
  size?: number;
  variant?: 'symbol' | 'logomark';
  className?: string;
  style?: ViewStyle;
  color?: 'light' | 'dark';
}

export function SprintLabLogo({
  size = 24,
  variant = 'symbol',
  className,
  style,
  color = 'dark',
  ...props
}: SprintLabLogoProps) {
  const { colorScheme } = useColorScheme();
  
  const isDark = colorScheme === 'dark';

  // Logomark is wide (708x142 = ~5:1 ratio), symbol is almost square (35x30)
  if (variant === 'logomark') {
    // For logomark, size = height, width scales proportionally (5:1 ratio)
    const logomarkWidth = size * 5;
    const logomarkHeight = size;
    
  const containerStyle: ViewStyle = {
      width: logomarkWidth,
      height: logomarkHeight,
    flexShrink: 0,
    ...style,
  };

    const LogomarkComponent = color === 'dark' ? LogomarkWhite : LogomarkBlack;
    return (
      <View 
        className={className}
        style={containerStyle}
        {...props}
      >
        <LogomarkComponent 
          width={logomarkWidth} 
          height={logomarkHeight}
        />
      </View>
    );
  }

  // Symbol is almost square
  const containerStyle: ViewStyle = {
    width: size,
    height: size,
    flexShrink: 0,
    ...style,
  };

  const SymbolComponent = color === 'dark' ? SprintLabSymbolWhite : SprintLabSymbolBlack;

  return (
    <View 
      className={className}
      style={containerStyle}
      {...props}
    >
      <SymbolComponent 
        width={size} 
        height={size}
      />
    </View>
  );
}

