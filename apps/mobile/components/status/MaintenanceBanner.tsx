import React, { useState, useEffect } from 'react';
import { View, Pressable } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { AlertCircle, X, Info } from 'lucide-react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

interface MaintenanceBannerProps {
  startTime: string;
  endTime: string;
}

export function MaintenanceBanner({ startTime, endTime }: MaintenanceBannerProps) {
  const [timeDisplay, setTimeDisplay] = useState<string>('');
  const [isMaintenanceActive, setIsMaintenanceActive] = useState(false);
  const [isDismissed, setIsDismissed] = useState(false);
  const [isMounted, setIsMounted] = useState(false);

  const maintenanceKey = `maintenance-dismissed-${startTime}-${endTime}`;

  useEffect(() => {
    setIsMounted(true);
    AsyncStorage.getItem(maintenanceKey).then((value) => {
      if (value === 'true') {
        setIsDismissed(true);
      }
    });
  }, [maintenanceKey]);

  useEffect(() => {
    const updateCountdown = () => {
      const now = new Date();
      const start = new Date(startTime);
      const end = new Date(endTime);

      if (now >= start && now <= end) {
        setIsMaintenanceActive(true);
        const diffToEnd = end.getTime() - now.getTime();

        if (diffToEnd <= 0) {
          setTimeDisplay('Maintenance completed');
          return;
        }

        const hours = Math.floor(diffToEnd / (1000 * 60 * 60));
        const minutes = Math.floor((diffToEnd % (1000 * 60 * 60)) / (1000 * 60));

        if (hours > 0) {
          setTimeDisplay(`${hours}h ${minutes}m remaining`);
        } else {
          setTimeDisplay(`${minutes}m remaining`);
        }
      } else if (now < start) {
        setIsMaintenanceActive(false);
        const diffToStart = start.getTime() - now.getTime();

        if (diffToStart <= 0) {
          setTimeDisplay('starting now');
          return;
        }

        const days = Math.floor(diffToStart / (1000 * 60 * 60 * 24));
        const hours = Math.floor((diffToStart % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
        const minutes = Math.floor((diffToStart % (1000 * 60 * 60)) / (1000 * 60));

        if (days > 0) {
          setTimeDisplay(`starting in ${days}d ${hours}h`);
        } else if (hours > 0) {
          setTimeDisplay(`starting in ${hours}h ${minutes}m`);
        } else {
          setTimeDisplay(`starting in ${minutes}m`);
        }
      } else {
        setTimeDisplay('');
      }
    };

    updateCountdown();
    const interval = setInterval(updateCountdown, 60000);
    return () => clearInterval(interval);
  }, [startTime, endTime]);

  const handleDismiss = async () => {
    setIsDismissed(true);
    await AsyncStorage.setItem(maintenanceKey, 'true');
  };

  const now = new Date();
  const end = new Date(endTime);

  if (!isMounted || now > end || isDismissed) {
    return null;
  }

  const getBgColor = () => {
    return isMaintenanceActive 
      ? 'bg-orange-500/10 border-orange-500/30'
      : 'bg-amber-500/10 border-amber-500/30';
  };

  const getTextColor = () => {
    return isMaintenanceActive ? 'text-orange-400' : 'text-amber-400';
  };

  return (
    <View className={`mx-4 mb-4 rounded-xl border p-3 ${getBgColor()}`}>
      <View className="flex-row items-center gap-2">
        <Icon as={AlertCircle} size={16} className={getTextColor()} />
        
        <View className="flex-1 flex-row items-center gap-2">
          <Text className={`font-roobert-medium text-sm ${getTextColor()}`}>
            {isMaintenanceActive 
              ? 'Scheduled maintenance in progress'
              : 'Scheduled maintenance'}
          </Text>
          {timeDisplay && (
            <>
              <Text className={`text-sm ${getTextColor()}`}>•</Text>
              <Text className={`text-sm ${getTextColor()}`}>{timeDisplay}</Text>
            </>
          )}
        </View>
        
        <Pressable
          onPress={handleDismiss}
          className="h-6 w-6 items-center justify-center rounded-full"
        >
          <Icon as={X} size={12} className={getTextColor()} />
        </Pressable>
      </View>
    </View>
  );
}
