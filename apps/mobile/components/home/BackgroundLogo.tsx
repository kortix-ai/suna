import * as React from 'react';
import { Dimensions, Animated, View } from 'react-native';
import { useColorScheme } from 'nativewind';
import KortixSymbolBlack from '@/assets/brand/kortix-symbol-scale-effect-black.svg';
import KortixSymbolWhite from '@/assets/brand/kortix-symbol-scale-effect-white.svg';
import { KortixLogo } from '../ui/KortixLogo';

const SCREEN_WIDTH = Dimensions.get('window').width;

interface BackgroundLogoProps {
  minimal?: boolean;
}

export function BackgroundLogo({ minimal = false }: BackgroundLogoProps) {
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

  if(minimal) {
    return (
      <View className="flex-1 bg-background items-center justify-center">
        <View className='mb-20 opacity-30'>
          <KortixLogo size={50} />
        </View>
      </View>
    );
  }

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