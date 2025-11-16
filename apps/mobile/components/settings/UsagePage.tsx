import * as React from 'react';
import { Pressable, View, ScrollView } from 'react-native';
import { SettingsHeader } from './SettingsHeader';
import * as Haptics from 'expo-haptics';
import { UsageContent } from './UsageContent';
import { useLanguage } from '@/contexts';
import { useChat } from '@/hooks';
import { useRouter } from 'expo-router';
import { KortixLoader } from '@/components/ui/kortix-loader';

interface UsagePageProps {
  visible: boolean;
  onClose: () => void;
}

export function UsagePage({ visible, onClose }: UsagePageProps) {
  const { t } = useLanguage();
  const chat = useChat();
  const router = useRouter();
  const [isLoadingThread, setIsLoadingThread] = React.useState(false);

  const handleClose = React.useCallback(() => {
    console.log('🎯 Usage page closing');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onClose();
  }, [onClose]);

  const handleThreadPress = React.useCallback(async (threadId: string, projectId: string | null) => {
    console.log('🎯 Thread pressed:', threadId);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    
    try {
      setIsLoadingThread(true);
      chat.loadThread(threadId);
      await new Promise(resolve => setTimeout(resolve, 500));
      onClose();
      router.push({
        pathname: '/home',
        params: { threadId: threadId }
      });
    } catch (error) {
      console.error('❌ Failed to load thread:', error);
    } finally {
      setIsLoadingThread(false);
    }
  }, [chat, onClose, router]);

  if (!visible) return null;

  return (
    <View className="absolute inset-0 z-50">
      <Pressable
        onPress={handleClose}
        className="absolute inset-0 bg-black/50"
      />
      
      <View className="absolute top-0 left-0 right-0 bottom-0 bg-background">
        {isLoadingThread ? (
          <View className="flex-1 items-center justify-center">
            <KortixLoader size="large" />
          </View>
        ) : (
          <ScrollView 
            className="flex-1" 
            showsVerticalScrollIndicator={false}
            removeClippedSubviews={true}
          >
            <SettingsHeader
              title={t('usage.title')}
              onClose={handleClose}
            />

            <UsageContent onThreadPress={handleThreadPress} />

            <View className="h-20" />
          </ScrollView>
        )}
      </View>
    </View>
  );
}

