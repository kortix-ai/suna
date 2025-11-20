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
  const isOpeningRef = React.useRef(false);
  const timeoutRef = React.useRef<NodeJS.Timeout | null>(null);

  const showAttachmentOptions = React.useCallback(() => {
    if (isOpeningRef.current) {
      console.log('📎 [AttachmentDrawer] Already opening, skipping');
      return;
    }
    isOpeningRef.current = true;

    // Safety timeout: reset if ActionSheet doesn't respond within 2 seconds
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      console.log('📎 [AttachmentDrawer] Timeout - resetting guard');
      isOpeningRef.current = false;
    }, 2000);
    const options = [
      t('attachments.takePicture'),
      t('attachments.chooseImages'),
      t('attachments.chooseFiles'),
      'Cancel'
    ];

    const clearGuard = () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
      isOpeningRef.current = false;
    };

    const actions = [
      () => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        clearGuard();
        onClose();
        setTimeout(onTakePicture, 100);
      },
      () => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        clearGuard();
        onClose();
        setTimeout(onChooseImages, 100);
      },
      () => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        clearGuard();
        onClose();
        setTimeout(onChooseFiles, 100);
      },
      () => {
        clearGuard();
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
          } else {
            clearGuard();
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

  // Handle visibility changes
  React.useEffect(() => {
    if (visible && !isOpeningRef.current) {
      console.log('📎 [AttachmentDrawer] Opening native action sheet');
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      showAttachmentOptions();
    } else if (!visible) {
      isOpeningRef.current = false;
    }
  }, [visible, showAttachmentOptions]);

  // This component doesn't render anything - it's just a controller
  return null;
}
