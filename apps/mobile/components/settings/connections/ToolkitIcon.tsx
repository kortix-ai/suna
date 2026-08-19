import * as React from 'react';
import { View, Image } from 'react-native';
import { SvgUri } from 'react-native-svg';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Plug2 } from 'lucide-react-native';
import { useComposioToolkitIcon } from '@/hooks/useComposio';

interface ToolkitIconProps {
  slug: string;
  name: string;
  size?: 'xs' | 'sm' | 'md' | 'lg';
  className?: string;
}

const sizeConfig = {
  xs: {
    container: 'h-5 w-5',
    image: 20,
    icon: 12,
    text: 'text-xs',
  },
  sm: {
    container: 'h-8 w-8',
    image: 32,
    icon: 16,
    text: 'text-xs',
  },
  md: {
    container: 'h-12 w-12',
    image: 48,
    icon: 20,
    text: 'text-sm',
  },
  lg: {
    container: 'h-16 w-16',
    image: 64,
    icon: 24,
    text: 'text-base',
  },
};

export function ToolkitIcon({ 
  slug, 
  name, 
  size = 'md', 
  className = '' 
}: ToolkitIconProps) {
  const { data: iconData, isLoading } = useComposioToolkitIcon(slug);
  const [imageError, setImageError] = React.useState(false);
  const [imageLoaded, setImageLoaded] = React.useState(false);
  
  const config = sizeConfig[size];
  const firstLetter = name?.charAt(0).toUpperCase() || '';
  const iconUrl = iconData?.success ? iconData.icon_url : null;

  React.useEffect(() => {
    setImageError(false);
    setImageLoaded(false);
  }, [iconUrl]);

  const handleImageError = React.useCallback(() => {
    setImageError(true);
    setImageLoaded(false);
  }, []);

  const handleImageLoad = React.useCallback(() => {
    setImageLoaded(true);
  }, []);

  const isPng = iconUrl?.toLowerCase().endsWith('.png');
  const shouldShowFallback = !iconUrl || imageError || isLoading;

  if (isLoading) {
    return (
      <View className={`${config.container} rounded-xl bg-muted/20 items-center justify-center ${className}`}>
        <View className="w-full h-full rounded-lg bg-muted/40 animate-pulse" />
      </View>
    );
  }

  return (
    <View className={`${config.container} items-center justify-center overflow-hidden ${className}`}>
      {iconUrl && !shouldShowFallback && (
        isPng ? (
          <Image 
            source={{ uri: iconUrl }} 
            style={{ width: config.image, height: config.image }}
            resizeMode="contain"
            onError={handleImageError}
            onLoad={handleImageLoad}
          />
        ) : (
          <SvgUri
            width="100%"
            height="100%"
            uri={iconUrl}
            onError={handleImageError}
            onLoad={handleImageLoad}
          />
        )
      )}
      
      {(shouldShowFallback || !imageLoaded) && (
        <View className="absolute inset-0 items-center justify-center">
          {firstLetter ? (
            <Text className={`${config.text} font-roobert-medium text-muted-foreground`}>
              {firstLetter}
            </Text>
          ) : (
            <Icon as={Plug2} size={config.icon} className="text-muted-foreground" />
          )}
        </View>
      )}
    </View>
  );
}
