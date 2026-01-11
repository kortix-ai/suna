import React, { useState, useEffect, useRef } from 'react';
import { View, ActivityIndicator, Image as RNImage, ImageProps } from 'react-native';
import { Icon } from '@/components/ui/icon';
import { AlertCircle } from 'lucide-react-native';
import { useColorScheme } from 'nativewind';

interface ImageLoaderProps extends Omit<ImageProps, 'source'> {
  source: { uri: string } | number;
  className?: string;
  showLoadingState?: boolean;
  maxRetries?: number;
  retryDelay?: number;
}

function sanitizeImageUrl(url: string): string {
  try {
    new URL(url);
    
    const urlObj = new URL(url);
    
    const pathParts = urlObj.pathname.split('/');
    const encodedPath = pathParts.map(part => {
      if (part.includes(' ') || part.includes('(') || part.includes(')')) {
        return encodeURIComponent(decodeURIComponent(part));
      }
      return part;
    }).join('/');
    
    urlObj.pathname = encodedPath;
    return urlObj.toString();
  } catch {
    return url;
  }
}

export function ImageLoader({
  source,
  className = '',
  showLoadingState = true,
  maxRetries = 3,
  retryDelay = 1000,
  ...imageProps
}: ImageLoaderProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  const [imageKey, setImageKey] = useState(0);
  const retryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const sanitizedSource = React.useMemo(() => {
    if (typeof source === 'object' && 'uri' in source && typeof source.uri === 'string') {
      const sanitized = sanitizeImageUrl(source.uri);
      return { uri: sanitized };
    }
    return source;
  }, [source]);

  useEffect(() => {
    return () => {
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    setRetryCount(0);
    setError(false);
    setLoading(true);
    setImageKey(prev => prev + 1);
  }, [source]);

  const handleError = () => {
    if (retryCount < maxRetries) {
      retryTimeoutRef.current = setTimeout(() => {
        setRetryCount(prev => prev + 1);
        setImageKey(prev => prev + 1);
        setError(false);
        setLoading(true);
      }, retryDelay);
    } else {
      setLoading(false);
      setError(true);
    }
  };

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
          key={imageKey}
          source={sanitizedSource}
          onLoadStart={() => {
            setLoading(true);
          }}
          onLoadEnd={() => {
            setLoading(false);
            setError(false);
          }}
          onError={() => {
            handleError();
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
