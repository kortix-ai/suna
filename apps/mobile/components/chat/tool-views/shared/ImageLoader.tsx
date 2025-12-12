import React, { useState } from 'react';
import { View, ActivityIndicator, Image as RNImage, ImageProps } from 'react-native';
import { Icon } from '@/components/ui/icon';
import { AlertCircle } from 'lucide-react-native';
import { useColorScheme } from 'nativewind';

interface ImageLoaderProps extends Omit<ImageProps, 'source'> {
  source: { uri: string } | number;
  className?: string;
  showLoadingState?: boolean;
}

export function ImageLoader({
  source,
  className = '',
  showLoadingState = true,
  ...imageProps
}: ImageLoaderProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  return (
    <View className={`relative ${className}`}>
      {loading && showLoadingState && (
        <View className="absolute inset-0 items-center justify-center bg-muted/30">
          <ActivityIndicator size="large" color={isDark ? '#a855f7' : '#9333ea'} />
        </View>
      )}
      {error ? (
        <View className="flex-1 items-center justify-center bg-muted/30 p-8">
          <Icon as={AlertCircle} size={32} className="text-muted-foreground mb-2" />
        </View>
      ) : (
        <RNImage
          {...imageProps}
          source={source}
          onLoadStart={() => {
            setLoading(true);
            setError(false);
          }}
          onLoadEnd={() => setLoading(false)}
          onError={() => {
            setLoading(false);
            setError(true);
          }}
          style={[
            imageProps.style,
            loading && { opacity: 0 },
          ]}
        />
      )}
    </View>
  );
}

