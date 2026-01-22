import * as React from 'react';
import { View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui';
import { QUICK_ACTIONS } from './quickActions';
import { QuickAction } from '.';
import { useLanguage } from '@/contexts';
import { MorphingModesSheet } from './MorphingModesSheet';

interface QuickActionBarProps {
  actions?: QuickAction[];
  onSelectMode?: (modeId: string, prompt: string) => void;
}

export function QuickActionBar({ 
  actions = QUICK_ACTIONS,
  onSelectMode,
}: QuickActionBarProps) {
  const [currentTab, setCurrentTab] = React.useState<string>('general');
  const { t } = useLanguage();

  const handleTabChange = React.useCallback((value: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setCurrentTab(value);
  }, []);

  return (
    <View className="w-full -mb-2">
      <View className="flex-row justify-center items-center gap-2 mt-3">
        <Tabs 
          value={currentTab} 
          onValueChange={handleTabChange}
          className="web:inline-flex"
        >
          <TabsList>
            <TabsTrigger value="general">
              General
            </TabsTrigger>
          </TabsList>
        </Tabs>
        
        <MorphingModesSheet
          isActive={currentTab === 'modes'}
          onSelectMode={onSelectMode}
        />
      </View>
    </View>
  );
}
