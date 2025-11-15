import * as React from 'react';
import { Modal, Pressable, View, ScrollView, Platform } from 'react-native';
import { SettingsHeader } from './SettingsHeader';
import * as Haptics from 'expo-haptics';
import { UsageContent } from './UsageContent';

interface UsageDrawerProps {
  visible: boolean;
  onClose: () => void;
  onUpgradePress?: () => void;
  onTopUpPress?: () => void;
}

export function UsageDrawer({ visible, onClose, onUpgradePress, onTopUpPress }: UsageDrawerProps) {
  const handleClose = React.useCallback(() => {
    console.log('🎯 Usage drawer closing');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onClose();
  }, [onClose]);

  const handleThreadPress = React.useCallback((threadId: string, projectId: string | null) => {
    console.log('🎯 Thread pressed:', threadId);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }, []);

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={handleClose}
    >
      <View className="flex-1 bg-background">
        <ScrollView 
          className="flex-1" 
          showsVerticalScrollIndicator={false}
          removeClippedSubviews={true}
        >
          <SettingsHeader
            title="Usage"
            onClose={handleClose}
            variant="close"
          />

          <UsageContent 
            onThreadPress={handleThreadPress}
            onUpgradePress={onUpgradePress}
            onTopUpPress={onTopUpPress}
          />

          <View className="h-20" />
        </ScrollView>
      </View>
    </Modal>
  );
}

