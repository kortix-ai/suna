import * as React from 'react';
import { View, type ViewProps, type ViewStyle } from 'react-native';
import { useColorScheme } from 'nativewind';
import KortixSymbolBlack from '@/assets/brand/kortix-symbol.svg';
import KortixSymbolWhite from '@/assets/brand/Symbol.svg';
import LogomarkBlack from '@/assets/brand/Logomark-Black.svg';
import LogomarkWhite from '@/assets/brand/Logomark-White.svg';

interface KortixLogoProps extends Omit<ViewProps, 'style'> {
  size?: number;
  variant?: 'symbol' | 'logomark';
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
  const { colorScheme } = useColorScheme();
  
  const isDark = colorScheme === 'dark';

  const containerStyle: ViewStyle = {
    width: size,
    height: size,
    flexShrink: 0,
    ...style,
  };

  if (variant === 'logomark') {
    const LogomarkComponent = color === 'dark' ? LogomarkWhite : LogomarkBlack;
    return (
      <View 
        className={className}
        style={containerStyle}
        {...props}
      >
        <LogomarkComponent 
          width={size} 
          height={size}
          color={color}
        />
      </View>
    );
  }

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

