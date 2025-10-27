import { useLanguage } from '@/contexts';
import * as Haptics from 'expo-haptics';
import { useColorScheme } from 'nativewind';
import * as React from 'react';
import { ActionSheetIOS, Platform, Alert } from 'react-native';

interface AttachmentDrawerProps {
  visible: boolean;
  onClose: () => void;
  onTakePicture: () => void;
  onChooseImages: () => void;
  onChooseFiles: () => void;
}

/**
 * AttachmentDrawer Component - Native ActionSheet implementation
 * 
 * Features:
 * - Uses native iOS ActionSheet and Android Alert
 * - Platform-specific native UI
 * - Zero custom UI overhead
 * - Native haptic feedback
 */
export function AttachmentDrawer({ 
  visible, 
  onClose, 
  onTakePicture,
  onChooseImages,
  onChooseFiles
}: AttachmentDrawerProps) {
  const { t } = useLanguage();

  // Handle visibility changes
  React.useEffect(() => {
    if (visible) {
      console.log('📎 [AttachmentDrawer] Opening native action sheet');
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      showAttachmentOptions();
    }
  }, [visible]);

  const showAttachmentOptions = React.useCallback(() => {
    const options = [
      t('attachments.takePicture'),
      t('attachments.chooseImages'),
      t('attachments.chooseFiles'),
      'Cancel'
    ];

    const actions = [
      () => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        onClose();
        setTimeout(onTakePicture, 100);
      },
      () => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        onClose();
        setTimeout(onChooseImages, 100);
      },
      () => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        onClose();
        setTimeout(onChooseFiles, 100);
      },
      () => {
        onClose();
      }
    ];

    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options,
          cancelButtonIndex: 3,
          title: t('attachments.addAttachment'),
        },
        (buttonIndex) => {
          if (buttonIndex !== undefined && buttonIndex < actions.length) {
            actions[buttonIndex]();
          }
        }
      );
    } else {
      Alert.alert(
        t('attachments.addAttachment'),
        t('attachments.chooseAttachment'),
        [
          {
            text: t('attachments.takePicture'),
            onPress: actions[0]
          },
          {
            text: t('attachments.chooseImages'),
            onPress: actions[1]
          },
          {
            text: t('attachments.chooseFiles'),
            onPress: actions[2]
          },
          {
            text: 'Cancel',
            style: 'cancel',
            onPress: actions[3]
          }
        ]
      );
    }
  }, [onTakePicture, onChooseImages, onChooseFiles, onClose, t]);

  // This component doesn't render anything - it's just a controller
  return null;
}
