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

// One row per variant × color: the SVG to render and its aspect ratio
// (the wide marks scale `size` by it; the symbol is square).
const LOGOS: Record<'symbol' | 'logomark' | 'text', Record<'light' | 'dark', { logo: React.ComponentType<{ width: number; height: number }>; ratio: number }>> = {
  symbol: {
    light: { logo: KortixSymbolBlack, ratio: 1 },
    dark: { logo: KortixSymbolWhite, ratio: 1 },
  },
  logomark: {
    light: { logo: LogomarkBlack, ratio: 5 },
    dark: { logo: LogomarkWhite, ratio: 5 },
  },
  text: {
    light: { logo: LogomarkTextBlack, ratio: 74 / 22 },
    dark: { logo: LogomarkTextWhite, ratio: 74 / 22 },
  },
};

export function KortixLogo({
  size = 24,
  variant = 'symbol',
  className,
  style,
  color = 'dark',
  ...props
}: KortixLogoProps) {
  const { logo: Logo, ratio } = LOGOS[variant][color];
  const width = size * ratio;
  const containerStyle: ViewStyle = { width, height: size, flexShrink: 0, ...style };
  return (
    <View className={className} style={containerStyle} {...props}>
      <Logo width={width} height={size} />
    </View>
  );
}
