import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { useLanguage } from '@/contexts';
import BottomSheet, { BottomSheetBackdrop, BottomSheetScrollView } from '@gorhom/bottom-sheet';
import type { BottomSheetBackdropProps } from '@gorhom/bottom-sheet';
import * as Haptics from 'expo-haptics';
import { Camera, FileText, Image } from 'lucide-react-native';
import { useColorScheme } from 'nativewind';
import * as React from 'react';
import { Pressable, View } from 'react-native';

interface AttachmentDrawerProps {
  visible: boolean;
  onClose: () => void;
  onTakePicture: () => void;
  onChooseImages: () => void;
  onChooseFiles: () => void;
}

interface AttachmentOptionProps {
  icon: typeof Camera;
  label: string;
  description: string;
  onPress: () => void;
}

function AttachmentOption({ icon, label, description, onPress }: AttachmentOptionProps) {
  return (
    <Pressable
      onPress={onPress}
      className="flex-row items-center p-4 rounded-2xl mb-3 bg-primary/5 active:bg-primary/15"
    >
      <View className="bg-primary/10 rounded-full items-center justify-center" style={{ width: 44, height: 44 }}>
        <Icon 
          as={icon} 
          size={22} 
          className="text-primary"
          strokeWidth={2}
        />
      </View>
      <View className="ml-4 flex-1">
        <Text className="text-foreground text-base font-roobert-semibold">
          {label}
        </Text>
        <Text className="text-foreground/60 text-sm font-roobert mt-0.5">
          {description}
        </Text>
      </View>
    </Pressable>
  );
}

/**
 * AttachmentDrawer Component
 * Bottom sheet for selecting attachment type
 */
export function AttachmentDrawer({ 
  visible, 
  onClose, 
  onTakePicture,
  onChooseImages,
  onChooseFiles
}: AttachmentDrawerProps) {
  const bottomSheetRef = React.useRef<BottomSheet>(null);
  const snapPoints = React.useMemo(() => ['50%'], []);
  const { colorScheme } = useColorScheme();
  const { t } = useLanguage();

  // Handle visibility changes
  React.useEffect(() => {
    if (visible) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      console.log('📳 Haptic Feedback: Attachment Drawer Opened');
      bottomSheetRef.current?.snapToIndex(0);
    } else {
      bottomSheetRef.current?.close();
    }
  }, [visible]);

  const handleOptionPress = React.useCallback((action: () => void, actionName: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    console.log('🎯 Attachment option selected:', actionName);
    onClose();
    // Slight delay to let drawer close before opening picker
    setTimeout(action, 300);
  }, [onClose]);

  const renderBackdrop = React.useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop
        {...props}
        disappearsOnIndex={-1}
        appearsOnIndex={0}
        opacity={0.5}
        pressBehavior="close"
      />
    ),
    []
  );

  const handleSheetChange = React.useCallback((index: number) => {
    if (index === -1) {
      onClose();
    }
  }, [onClose]);

  return (
    <BottomSheet
      ref={bottomSheetRef}
      index={-1}
      snapPoints={snapPoints}
      enablePanDownToClose
      onChange={handleSheetChange}
      backdropComponent={renderBackdrop}
      backgroundStyle={{ 
        backgroundColor: colorScheme === 'dark' ? '#161618' : '#FFFFFF'
      }}
      handleIndicatorStyle={{ 
        backgroundColor: colorScheme === 'dark' ? '#3F3F46' : '#D4D4D8',
        width: 36,
        height: 5,
        borderRadius: 3,
        marginTop: 8,
        marginBottom: 0
      }}
      enableDynamicSizing={false}
      style={{
        borderTopLeftRadius: 24,
        borderTopRightRadius: 24,
        overflow: 'hidden'
      }}
    >
      <View className="px-6 pb-10">
        {/* Header */}
        <View className="mb-4 mt-6">
          <Text className="text-foreground text-xl font-roobert-semibold">
            {t('attachments.addAttachment')}
          </Text>
          <Text className="text-foreground/60 text-sm font-roobert mt-1">
            {t('attachments.chooseAttachment')}
          </Text>
        </View>

        {/* Options */}
        <View>
          <AttachmentOption
            icon={Camera}
            label={t('attachments.takePicture')}
            description={t('attachments.takePictureDescription')}
            onPress={() => handleOptionPress(onTakePicture, 'Take Picture')}
          />
          <AttachmentOption
            icon={Image}
            label={t('attachments.chooseImages')}
            description={t('attachments.chooseImagesDescription')}
            onPress={() => handleOptionPress(onChooseImages, 'Choose Images')}
          />
          <AttachmentOption
            icon={FileText}
            label={t('attachments.chooseFiles')}
            description={t('attachments.chooseFilesDescription')}
            onPress={() => handleOptionPress(onChooseFiles, 'Choose Files')}
          />
        </View>
      </View>
    </BottomSheet>
  );
}
