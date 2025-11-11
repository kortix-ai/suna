import * as React from 'react';
import { Modal, View, Pressable, Dimensions } from 'react-native';
import { WebView } from 'react-native-webview';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { X } from 'lucide-react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

interface TemplatePreviewModalProps {
  visible: boolean;
  onClose: () => void;
  templateId: string;
  templateName: string;
}

/**
 * Gets the PDF URL for a presentation template
 */
const getPdfUrl = (templateId: string): string => {
  // Use the backend URL from environment or default
  const API_URL = process.env.EXPO_PUBLIC_BACKEND_URL || 'https://api.agentpress.ai';
  return `${API_URL}/presentation-templates/${templateId}/pdf#toolbar=0&navpanes=0&scrollbar=0&view=FitH`;
};

/**
 * TemplatePreviewModal Component
 * 
 * Displays a full-screen modal with PDF preview of presentation template.
 * Uses WebView to render the PDF with proper scaling and controls.
 */
export function TemplatePreviewModal({
  visible,
  onClose,
  templateId,
  templateName,
}: TemplatePreviewModalProps) {
  const insets = useSafeAreaInsets();
  const { width: screenWidth, height: screenHeight } = Dimensions.get('window');

  const pdfUrl = getPdfUrl(templateId);

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={onClose}
    >
      <View className="flex-1 bg-background">
        {/* Header */}
        <Animated.View 
          entering={FadeIn.duration(200)}
          className="bg-card border-b border-border"
          style={{ paddingTop: insets.top }}
        >
          <View className="flex-row items-center justify-between px-4 py-4">
            <View className="flex-1 pr-4">
              <Text className="text-base font-roobert-medium text-foreground" numberOfLines={1}>
                Template Preview
              </Text>
              <Text className="text-sm text-muted-foreground mt-0.5" numberOfLines={1}>
                {templateName}
              </Text>
            </View>
            <Pressable
              onPress={onClose}
              className="w-10 h-10 items-center justify-center rounded-full bg-muted/50 active:bg-muted"
            >
              <Icon as={X} size={20} className="text-foreground" />
            </Pressable>
          </View>
        </Animated.View>

        {/* PDF Content */}
        <View className="flex-1 bg-muted/20">
          <WebView
            source={{ uri: pdfUrl }}
            onError={(syntheticEvent) => {
              const { nativeEvent } = syntheticEvent;
              console.error('WebView error:', nativeEvent);
            }}
            style={{ 
              width: screenWidth, 
              height: screenHeight,
              backgroundColor: 'transparent'
            }}
            scalesPageToFit
            startInLoadingState
            allowsInlineMediaPlayback
            mediaPlaybackRequiresUserAction={false}
            javaScriptEnabled
            domStorageEnabled
          />
        </View>
      </View>
    </Modal>
  );
}

