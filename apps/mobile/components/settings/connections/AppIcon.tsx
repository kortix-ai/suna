/**
 * AppIcon — renders a Pipedream app icon from its imgSrc URL.
 * Falls back to a first-letter avatar if no image or load error.
 */

import React, { useState, memo } from 'react';
import { View, Image } from 'react-native';
import { Text } from '@/components/ui/text';
import { useColorScheme } from 'nativewind';

interface AppIconProps {
  name: string;
  imgSrc?: string;
  size?: number;
}

export const AppIcon = memo(function AppIcon({ name, imgSrc, size = 36 }: AppIconProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const [error, setError] = useState(false);

  const letter = (name || '?').charAt(0).toUpperCase();
  const radius = size * 0.25;
  const fontSize = size * 0.4;

  if (imgSrc && !error) {
    return (
      <Image
        source={{ uri: imgSrc }}
        style={{
          width: size,
          height: size,
          borderRadius: radius,
        }}
        onError={() => setError(true)}
        resizeMode="contain"
      />
    );
  }

  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)',
      }}
    >
      <Text
        style={{
          fontSize,
          fontFamily: 'Roobert-Medium',
          color: isDark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.4)',
        }}
      >
        {letter}
      </Text>
    </View>
  );
});
