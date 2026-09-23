import * as React from 'react';
import { View, type ViewProps, type ViewStyle } from 'react-native';
import KortixSymbolBlack from '@/assets/brand/kortix-symbol.svg';
import KortixSymbolWhite from '@/assets/brand/Symbol.svg';
import LogomarkBlack from '@/assets/brand/Logomark-Black.svg';
import LogomarkWhite from '@/assets/brand/Logomark-White.svg';
import LogomarkTextBlack from '@/assets/brand/Logomark-Text-Black.svg';
import LogomarkTextWhite from '@/assets/brand/Logomark-Text-White.svg';

interface KortixLogoProps extends Omit<ViewProps, 'style'> {
  size?: number;
  variant?: 'symbol' | 'logomark' | 'text';
  className?: string;
  style?: ViewStyle;
  color?: 'light' | 'dark';
}

export function KortixLogo({ 
  size = 24, 
  variant = 'symbol',
  className,
  style,
  color = 'dark',
  ...props 
}: KortixLogoProps) {
  // Logomark is wide (112x22 ≈ 5:1), text logomark is 74x22 ≈ 3.36:1, symbol is almost square
  if (variant === 'logomark' || variant === 'text') {
    const aspectRatio = variant === 'text' ? 74 / 22 : 5;
    const logoWidth = size * aspectRatio;
    const logoHeight = size;

    const containerStyle: ViewStyle = {
      width: logoWidth,
      height: logoHeight,
      flexShrink: 0,
      ...style,
    };

    const LogoComponent =
      variant === 'text'
        ? color === 'dark'
          ? LogomarkTextWhite
          : LogomarkTextBlack
        : color === 'dark'
          ? LogomarkWhite
          : LogomarkBlack;

    return (
      <View
        className={className}
        style={containerStyle}
        {...props}
      >
        <LogoComponent
          width={logoWidth}
          height={logoHeight}
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

  const SymbolComponent = color === 'dark' ? KortixSymbolWhite : KortixSymbolBlack;

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

