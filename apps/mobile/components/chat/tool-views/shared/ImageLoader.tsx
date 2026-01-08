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

/**
 * Sanitize image URL by encoding special characters that may cause loading issues
 */
function sanitizeImageUrl(url: string): string {
  try {
    // Check if URL is already valid
    new URL(url);
    
    // Split URL into base and path parts
    const urlObj = new URL(url);
    
    // Encode path segments individually to handle special characters
    const pathParts = urlObj.pathname.split('/');
    const encodedPath = pathParts.map(part => {
      // Only encode if it contains special characters that aren't already encoded
      if (part.includes(' ') || part.includes('(') || part.includes(')')) {
        return encodeURIComponent(decodeURIComponent(part));
      }
      return part;
    }).join('/');
    
    urlObj.pathname = encodedPath;
    return urlObj.toString();
  } catch {
    // If URL parsing fails, return original
    return url;
  }
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

  // Sanitize the URL if it's a string URI
  const sanitizedSource = React.useMemo(() => {
    if (typeof source === 'object' && 'uri' in source && typeof source.uri === 'string') {
      const sanitized = sanitizeImageUrl(source.uri);
      console.log('[ImageLoader] Sanitized URL:', { original: source.uri.substring(0, 80), sanitized: sanitized.substring(0, 80) });
      return { uri: sanitized };
    }
    return source;
  }, [source]);

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
          source={sanitizedSource}
          onLoadStart={() => {
            console.log('[ImageLoader] onLoadStart:', sanitizedSource);
            setLoading(true);
            setError(false);
          }}
          onLoadEnd={() => {
            console.log('[ImageLoader] ✅ onLoadEnd - image loaded successfully');
            setLoading(false);
          }}
          onError={(e) => {
            console.log('[ImageLoader] ❌ onError:', e.nativeEvent);
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

