import * as React from 'react';
import { Dimensions, Animated } from 'react-native';
import { useColorScheme } from 'nativewind';
import KortixSymbolBlack from '@/assets/brand/kortix-symbol-scale-effect-black.svg';
import KortixSymbolWhite from '@/assets/brand/kortix-symbol-scale-effect-white.svg';

const SCREEN_WIDTH = Dimensions.get('window').width;

/**
 * Background Logo Component with Simple Fade
 */
export function BackgroundLogo() {
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

  const leftOffset = (SCREEN_WIDTH - 393) / 2;
  const SymbolComponent = colorScheme === 'dark' ? KortixSymbolWhite : KortixSymbolBlack;

  return (
    <Animated.View
      style={{
        position: 'absolute',
        top: 138,
        left: -80 + leftOffset,
        width: 554,
        height: 462,
        opacity: fadeAnim,
      }}
    >
      <SymbolComponent width={554} height={462} />
    </Animated.View>
  );
}