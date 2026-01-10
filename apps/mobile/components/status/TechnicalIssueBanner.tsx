import React, { useState, useEffect } from 'react';
import { View, Pressable, Linking } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { AlertTriangle, X, ExternalLink } from 'lucide-react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Animated, { 
  FadeInDown,
  FadeOutDown,
} from 'react-native-reanimated';

interface TechnicalIssueBannerProps {
  message: string;
  statusUrl?: string;
  description?: string;
  estimatedResolution?: string;
  severity?: 'degraded' | 'outage' | 'maintenance';
  affectedServices?: string[];
}

export function TechnicalIssueBanner({
  message,
  statusUrl,
  description,
  estimatedResolution,
  severity = 'degraded',
  affectedServices,
}: TechnicalIssueBannerProps) {
  const [isDismissed, setIsDismissed] = useState(false);
  const [isMounted, setIsMounted] = useState(false);

  const dismissKey = `technical-issue-dismissed-${message}`;

  useEffect(() => {
    setIsMounted(true);
    AsyncStorage.getItem(dismissKey).then((value) => {
      if (value === 'true') {
        setIsDismissed(true);
      }
    });
  }, [dismissKey]);

  const handleDismiss = async () => {
    setIsDismissed(true);
    await AsyncStorage.setItem(dismissKey, 'true');
  };

  const handleStatusPress = () => {
    if (statusUrl) {
      Linking.openURL(statusUrl).catch(console.warn);
    }
  };

  if (!isMounted || isDismissed) {
    return null;
  }

  const getSeverityColor = () => {
    switch (severity) {
      case 'outage':
        return 'bg-destructive/10 border-destructive/30';
      case 'maintenance':
        return 'bg-amber-500/10 border-amber-500/30';
      default:
        return 'bg-orange-500/10 border-orange-500/30';
    }
  };

  return (
    <Animated.View
      entering={FadeInDown.duration(300)}
      exiting={FadeOutDown.duration(200)}
      className="mx-4 mb-4"
    >
      <View className={`rounded-2xl border p-4 ${getSeverityColor()}`}>
        <Pressable
          onPress={handleDismiss}
          className="absolute right-2 top-2 z-10 h-6 w-6 items-center justify-center rounded-full bg-background/50"
        >
          <Icon as={X} size={12} className="text-foreground" />
        </Pressable>

        <View className="flex-row items-start gap-3 pr-6">
          <View className="h-10 w-10 items-center justify-center rounded-xl bg-destructive/20 border border-destructive/30">
            <Icon as={AlertTriangle} size={20} className="text-destructive" />
          </View>
          
          <View className="flex-1">
            <Text className="font-roobert-semibold text-sm text-foreground">
              Technical Issue
            </Text>
            <Text className="mt-0.5 text-xs text-muted-foreground leading-relaxed">
              {message}
            </Text>
            
            {description && (
              <Text className="mt-2 text-xs text-muted-foreground leading-relaxed">
                {description}
              </Text>
            )}
            
            {affectedServices && affectedServices.length > 0 && (
              <View className="mt-2 flex-row flex-wrap gap-1">
                {affectedServices.map((service, index) => (
                  <View key={index} className="rounded-md bg-muted px-2 py-0.5">
                    <Text className="text-xs text-muted-foreground">{service}</Text>
                  </View>
                ))}
              </View>
            )}
            
            {estimatedResolution && (
              <Text className="mt-2 text-xs text-muted-foreground">
                Est. resolution: {estimatedResolution}
              </Text>
            )}
            
            {statusUrl && (
              <Pressable
                onPress={handleStatusPress}
                className="mt-3 flex-row items-center gap-1"
              >
                <Text className="font-roobert-medium text-xs text-foreground">
                  View Status
                </Text>
                <Icon as={ExternalLink} size={12} className="text-foreground" />
              </Pressable>
            )}
          </View>
        </View>
      </View>
    </Animated.View>
  );
}
