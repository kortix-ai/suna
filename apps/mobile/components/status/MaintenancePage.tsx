import React from 'react';
import { View, Pressable } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { KortixLoader } from '@/components/ui/kortix-loader';
import { KortixLogo } from '@/components/ui/KortixLogo';
import { RefreshCw } from 'lucide-react-native';
import { useColorScheme } from 'nativewind';

interface MaintenancePageProps {
  onRefresh?: () => void;
  isRefreshing?: boolean;
}

export function MaintenancePage({ onRefresh, isRefreshing = false }: MaintenancePageProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';

  return (
    <View className="flex-1 items-center justify-center bg-background px-6">
      <View className="w-full max-w-sm items-center">
        <KortixLogo size={32} color={isDark ? 'dark' : 'light'} />
        
        <Text className="mt-8 text-center font-roobert-semibold text-3xl text-foreground">
          We'll Be Right Back
        </Text>
        
        <Text className="mt-4 text-center text-base text-muted-foreground leading-relaxed">
          Performing scheduled maintenance to enhance system stability. All services will resume shortly.
        </Text>
        
        <View className="mt-8 w-full rounded-2xl border border-border bg-card p-5">
          <View className="flex-row items-center justify-between">
            <View className="flex-row items-center gap-3">
              <View className="h-2.5 w-2.5 rounded-full border border-destructive border-t-transparent animate-spin" />
              <View>
                <Text className="font-roobert-semibold text-base text-destructive">
                  Services Offline
                </Text>
                <Text className="mt-0.5 text-sm text-muted-foreground">
                  All Worker executions are paused
                </Text>
              </View>
            </View>
            
            <Pressable
              onPress={onRefresh}
              disabled={isRefreshing}
              className="h-12 w-12 items-center justify-center rounded-xl bg-muted active:opacity-80"
            >
              {isRefreshing ? (
                <KortixLoader size="small" customSize={20} />
              ) : (
                <Icon as={RefreshCw} size={20} className="text-foreground" />
              )}
            </Pressable>
          </View>
        </View>
      </View>
    </View>
  );
}
