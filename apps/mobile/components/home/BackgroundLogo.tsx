import * as React from 'react';
import { Dimensions, Animated, View } from 'react-native';
import { useColorScheme } from 'nativewind';
import { LinearGradient } from 'expo-linear-gradient';
import KortixSymbolBlack from '@/assets/brand/kortix-symbol-scale-effect-black.svg';
import KortixSymbolWhite from '@/assets/brand/kortix-symbol-scale-effect-white.svg';

const SCREEN_WIDTH = Dimensions.get('window').width;

interface BackgroundLogoProps {
  onSuggestionClick?: (suggestion: string) => void;
}

/**
 * Background Logo Component with Simple Fade
 */
export function BackgroundLogo({ onSuggestionClick }: BackgroundLogoProps) {
  const { colorScheme } = useColorScheme();
  const fadeAnim = React.useRef(new Animated.Value(0)).current;

  React.useEffect(() => {
    // Simple slow fade in
    Animated.timing(fadeAnim, {
      toValue: 1.0, // 100% opacity
      duration: 3500, 
      useNativeDriver: true,
    }).start();
  }, []);

  const SymbolComponent = colorScheme === 'dark' ? KortixSymbolWhite : KortixSymbolBlack;

  // Gradient colors for top fade - matches Kortix Brand Styleguide bg-background
  const gradientColors = React.useMemo(
    () => colorScheme === 'dark' 
      ? ['rgba(23, 23, 23, 1)', 'rgba(23, 23, 23, 0.6)', 'rgba(23, 23, 23, 0)'] as const // #171717 - dark bg
      : ['rgba(246, 246, 246, 1)', 'rgba(246, 246, 246, 0.6)', 'rgba(246, 246, 246, 0)'] as const, // #f6f6f6 - brand bg
    [colorScheme]
  );

  // Calculate logo center position
  const logoTop = 138;
  const logoWidth = 554;
  const logoHeight = 462;
  const logoCenterY = logoTop + (logoHeight / 2);
  // Center the logo horizontally on any screen size
  const logoLeft = (SCREEN_WIDTH - logoWidth) / 2;

  return (
    <View style={{ flex: 1 }}>
      {/* Logo with gradient overlay */}
      <Animated.View
        style={{
          position: 'absolute',
          top: logoTop,
          left: logoLeft,
          width: logoWidth,
          height: logoHeight,
          opacity: fadeAnim,
        }}
      >
        <SymbolComponent width={554} height={462} />
        
        {/* Top gradient fade overlay */}
        <LinearGradient
          colors={gradientColors}
          locations={[0, 0.3, 0.5]}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            height: 200,
          }}
          pointerEvents="none"
        />
      </Animated.View>

    </View>
  );
}