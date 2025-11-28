import * as React from 'react';
import { Pressable, View, ScrollView } from 'react-native';
import { SettingsHeader } from './SettingsHeader';
import * as Haptics from 'expo-haptics';
import { UsageContent } from './UsageContent';
import { PlanPage } from './PlanPage';
import { useLanguage } from '@/contexts';
import { useChat } from '@/hooks';
import { AnimatedPageWrapper } from '@/components/shared/AnimatedPageWrapper';

interface UsagePageProps {
  visible: boolean;
  onClose: () => void;
}

export function UsagePage({ visible, onClose }: UsagePageProps) {
  const { t } = useLanguage();
  const chat = useChat();
  const [isPlanPageVisible, setIsPlanPageVisible] = React.useState(false);

  const handleClose = React.useCallback(() => {
    console.log('🎯 Usage page closing');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onClose();
  }, [onClose]);

  const handleUpgradePress = React.useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onClose();
    setTimeout(() => setIsPlanPageVisible(true), 100);
  }, [onClose]);

  const handleThreadPress = React.useCallback((threadId: string, _projectId: string | null) => {
    console.log('🎯 Thread pressed from UsagePage:', threadId);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    
    // Load the thread and close the page
    chat.loadThread(threadId);
    onClose();
  }, [chat, onClose]);

  if (!visible) return null;

  return (
    <View className="absolute inset-0 z-50">
      <Pressable
        onPress={handleClose}
        className="absolute inset-0 bg-black/50"
      />
      
      <View className="absolute top-0 left-0 right-0 bottom-0 bg-background">
        <ScrollView 
          className="flex-1" 
          showsVerticalScrollIndicator={false}
          removeClippedSubviews={true}
        >
          <SettingsHeader
            title={t('usage.title')}
            onClose={handleClose}
          />

          <UsageContent 
            onThreadPress={handleThreadPress} 
            onUpgradePress={handleUpgradePress}
          />

          <View className="h-20" />
        </ScrollView>
      </View>

      {/* Plan Page */}
      <AnimatedPageWrapper visible={isPlanPageVisible} onClose={() => setIsPlanPageVisible(false)} disableGesture>
        <PlanPage
          visible
          onClose={() => setIsPlanPageVisible(false)}
        />
      </AnimatedPageWrapper>
    </View>
  );
}

