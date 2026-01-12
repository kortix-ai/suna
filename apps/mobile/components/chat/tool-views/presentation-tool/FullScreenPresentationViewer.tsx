import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  View,
  Modal,
  Pressable,
  Dimensions,
  ScrollView,
  Linking,
  LayoutChangeEvent,
  Alert,
} from 'react-native';
import { WebView } from 'react-native-webview';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { KortixLoader } from '@/components/ui';
import {
  X,
  ChevronLeft,
  ChevronRight,
  Download,
  Presentation,
  SkipBack,
  SkipForward,
  FileText,
  FileIcon,
  ExternalLink,
} from 'lucide-react-native';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  FadeIn,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { API_URL, getAuthHeaders } from '@/api/config';
import { log } from '@/lib/logger';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

interface SlideMetadata {
  title: string;
  filename: string;
  file_path: string;
  preview_url: string;
  created_at: string;
}

interface PresentationMetadata {
  presentation_name: string;
  title: string;
  description: string;
  slides: Record<string, SlideMetadata>;
  created_at: string;
  updated_at: string;
}

interface FullScreenPresentationViewerProps {
  visible: boolean;
  onClose: () => void;
  presentationName?: string;
  sandboxUrl?: string;
  initialSlide?: number;
}

const constructHtmlPreviewUrl = (sandboxUrl: string, filePath: string): string => {
  const processedPath = filePath.replace(/^\/workspace\//, '');
  const pathSegments = processedPath.split('/').map(segment => encodeURIComponent(segment));
  const encodedPath = pathSegments.join('/');
  return `${sandboxUrl}/${encodedPath}`;
};

const sanitizeFilename = (name: string): string => {
  return name.replace(/[^a-zA-Z0-9\-_]/g, '').toLowerCase();
};

export function FullScreenPresentationViewer({
  visible,
  onClose,
  presentationName,
  sandboxUrl,
  initialSlide = 1,
}: FullScreenPresentationViewerProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const insets = useSafeAreaInsets();
  const { width: screenWidth } = Dimensions.get('window');

  const [metadata, setMetadata] = useState<PresentationMetadata | null>(null);
  const [currentSlide, setCurrentSlide] = useState(initialSlide);
  const [isLoading, setIsLoading] = useState(false);
  const [retryAttempt, setRetryAttempt] = useState(0);
  const retryTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const hasLoadedRef = useRef(false);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [isExporting, setIsExporting] = useState<'pdf' | 'pptx' | 'google' | null>(null);
  const [containerWidth, setContainerWidth] = useState(screenWidth - 32);

  const closeScale = useSharedValue(1);

  const refreshTimestamp = useMemo(() => metadata?.updated_at || Date.now(), [metadata?.updated_at]);

  const slides = metadata
    ? Object.entries(metadata.slides)
      .map(([num, slide]) => ({ number: parseInt(num), ...slide }))
      .sort((a, b) => a.number - b.number)
    : [];

  const totalSlides = slides.length;

  // Load metadata with retry logic
  const loadMetadata = useCallback(async (retryCount = 0) => {
    if (hasLoadedRef.current) return;
    if (!presentationName || !sandboxUrl) {
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    setRetryAttempt(retryCount);

    try {
      const sanitizedPresentationName = sanitizeFilename(presentationName);
      const metadataUrl = constructHtmlPreviewUrl(
        sandboxUrl,
        `presentations/${sanitizedPresentationName}/metadata.json`
      );
      const urlWithCacheBust = `${metadataUrl}?t=${Date.now()}`;

      const response = await fetch(urlWithCacheBust, {
        cache: 'no-cache',
        headers: { 'Cache-Control': 'no-cache' },
      });

      if (response.ok) {
        const data = await response.json();
        setMetadata(data);
        hasLoadedRef.current = true;
        setIsLoading(false);

        if (retryTimeoutRef.current) {
          clearTimeout(retryTimeoutRef.current);
          retryTimeoutRef.current = null;
        }
        return;
      } else {
        throw new Error(`HTTP ${response.status}`);
      }
    } catch (err) {
      log.error(`Error loading metadata (attempt ${retryCount + 1}):`, err);

      const delay = retryCount < 5
        ? Math.min(1000 * Math.pow(2, retryCount), 10000)
        : 5000;

      retryTimeoutRef.current = setTimeout(() => {
        loadMetadata(retryCount + 1);
      }, delay) as any;
    }
  }, [presentationName, sandboxUrl]);

  useEffect(() => {
    if (visible) {
      hasLoadedRef.current = false;

      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current);
        retryTimeoutRef.current = null;
      }

      if (presentationName && sandboxUrl) {
        loadMetadata();
      } else {
        setIsLoading(false);
      }
      setCurrentSlide(initialSlide);
      setShowExportMenu(false);
    } else {
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current);
        retryTimeoutRef.current = null;
      }
    }
  }, [visible, presentationName, sandboxUrl, initialSlide, loadMetadata]);

  useEffect(() => {
    return () => {
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current);
      }
    };
  }, []);

  // Navigation
  const goToNextSlide = useCallback(() => {
    if (currentSlide < totalSlides) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      setCurrentSlide(prev => prev + 1);
    }
  }, [currentSlide, totalSlides]);

  const goToPreviousSlide = useCallback(() => {
    if (currentSlide > 1) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      setCurrentSlide(prev => prev - 1);
    }
  }, [currentSlide]);

  const goToFirstSlide = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setCurrentSlide(1);
  }, []);

  const goToLastSlide = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setCurrentSlide(totalSlides);
  }, [totalSlides]);

  const handleClose = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setShowExportMenu(false);
    onClose();
  };

  // Export PDF/PPTX - POST to sandbox API, download blob, share via native sheet
  const handleExportFile = async (format: 'pdf' | 'pptx') => {
    if (!sandboxUrl || !presentationName) return;

    setIsExporting(format);
    setShowExportMenu(false);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    try {
      const presentationPath = `/workspace/presentations/${presentationName}`;
      const exportUrl = `${sandboxUrl}/presentation/convert-to-${format}`;

      log.log(`📤 Exporting ${format}:`, exportUrl);

      // POST request to sandbox API (matching frontend)
      const response = await fetch(exportUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          presentation_path: presentationPath,
          download: true,
        }),
      });

      if (!response.ok) {
        throw new Error(`Failed to export ${format}: ${response.status}`);
      }

      // Get the blob
      const blob = await response.blob();

      // Convert blob to base64 and save to file system
      const reader = new FileReader();
      reader.readAsDataURL(blob);

      reader.onloadend = async () => {
        try {
          const base64data = reader.result as string;
          // Remove the data URL prefix (e.g., "data:application/pdf;base64,")
          const base64Content = base64data.split(',')[1];

          const fileName = `${presentationName}.${format}`;
          const fileUri = `${FileSystem.cacheDirectory}${fileName}`;

          // Write base64 to file
          await FileSystem.writeAsStringAsync(fileUri, base64Content, {
            encoding: FileSystem.EncodingType.Base64,
          });

          // Use expo-sharing for native share sheet
          const isSharingAvailable = await Sharing.isAvailableAsync();

          if (isSharingAvailable) {
            await Sharing.shareAsync(fileUri, {
              mimeType: format === 'pdf'
                ? 'application/pdf'
                : 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
              dialogTitle: `Save ${fileName}`,
            });
          } else {
            Alert.alert('Success', `${fileName} has been saved to cache.`);
          }
        } catch (saveError) {
          log.error('Error saving file:', saveError);
          Alert.alert('Error', 'Failed to save the file.');
        } finally {
          setIsExporting(null);
        }
      };

      reader.onerror = () => {
        log.error('Error reading blob');
        Alert.alert('Error', 'Failed to process the file.');
        setIsExporting(null);
      };

    } catch (error) {
      log.error(`Error exporting ${format}:`, error);
      Alert.alert('Export Failed', `Could not export as ${format.toUpperCase()}. Please try again.`);
      setIsExporting(null);
    }
  };

  // Export to Google Slides - calls backend API
  const handleExportGoogleSlides = async () => {
    if (!sandboxUrl || !presentationName) return;

    setIsExporting('google');
    setShowExportMenu(false);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    try {
      const presentationPath = `/workspace/presentations/${presentationName}`;
      const authHeaders = await getAuthHeaders();

      log.log('📤 Exporting to Google Slides via backend API');

      const response = await fetch(`${API_URL}/presentation-tools/convert-and-upload-to-slides`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          presentation_path: presentationPath,
          sandbox_url: sandboxUrl,
        }),
      });

      const result = await response.json();

      if (!response.ok && response.status !== 200) {
        // Check if it's an auth issue
        if (result.is_api_enabled === false || result.message?.includes('not enabled')) {
          // Get Google auth URL and prompt user
          const authResponse = await fetch(`${API_URL}/google/auth-url`, {
            method: 'GET',
            headers: authHeaders,
          });

          if (authResponse.ok) {
            const authData = await authResponse.json();
            Alert.alert(
              'Connect Google Account',
              'You need to connect your Google account to use this feature. This will open in your browser.',
              [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: 'Connect Google',
                  onPress: () => Linking.openURL(authData.auth_url)
                },
              ]
            );
          } else {
            Alert.alert(
              'Google Authentication Required',
              'Please connect your Google account in the web app settings first.',
              [{ text: 'OK' }]
            );
          }
          return;
        }
        throw new Error(result.message || 'Failed to upload to Google Slides');
      }

      // Also check for is_api_enabled in successful response (backend returns 200 with success: false)
      if (result.success === false && result.is_api_enabled === false) {
        const authResponse = await fetch(`${API_URL}/google/auth-url`, {
          method: 'GET',
          headers: authHeaders,
        });

        if (authResponse.ok) {
          const authData = await authResponse.json();
          Alert.alert(
            'Connect Google Account',
            'You need to connect your Google account to use this feature. This will open in your browser.',
            [
              { text: 'Cancel', style: 'cancel' },
              {
                text: 'Connect Google',
                onPress: () => Linking.openURL(authData.auth_url)
              },
            ]
          );
        } else {
          Alert.alert(
            'Google Authentication Required',
            'Please connect your Google account in the web app settings first.',
            [{ text: 'OK' }]
          );
        }
        return;
      }

      if (result.google_slides_url) {
        Alert.alert(
          'Success!',
          'Presentation uploaded to Google Slides.',
          [
            { text: 'Close', style: 'cancel' },
            {
              text: 'Open in Google Slides',
              onPress: () => Linking.openURL(result.google_slides_url)
            },
          ]
        );
      }
    } catch (error) {
      log.error('Error uploading to Google Slides:', error);
      Alert.alert('Export Failed', 'Could not upload to Google Slides. Please try again.');
    } finally {
      setIsExporting(null);
    }
  };

  const currentSlideData = slides.find(slide => slide.number === currentSlide);

  // Animated styles
  const closeAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: closeScale.value }],
  }));

  // Calculate scale for 16:9 slide
  const slideWidth = containerWidth;
  const scale = slideWidth / 1920;

  const handleContainerLayout = useCallback((event: LayoutChangeEvent) => {
    const { width } = event.nativeEvent.layout;
    setContainerWidth(width);
  }, []);

  // Inject JavaScript for proper scaling
  const injectedJS = `
    (function() {
      const existingViewport = document.querySelector('meta[name="viewport"]');
      if (existingViewport) existingViewport.remove();
      
      const viewport = document.createElement('meta');
      viewport.name = 'viewport';
      viewport.content = 'width=1920, initial-scale=1, user-scalable=no';
      document.head.appendChild(viewport);
      
      const style = document.createElement('style');
      style.textContent = \`
        * { box-sizing: border-box; }
        html, body {
          margin: 0;
          padding: 0;
          width: 1920px;
          height: 1080px;
          overflow: hidden;
          background: white;
        }
      \`;
      document.head.appendChild(style);
      true;
    })();
  `;

  if (!visible) return null;

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={handleClose}
    >
      <View
        className="flex-1"
        style={{ backgroundColor: isDark ? '#121215' : '#ffffff' }}
      >
        {/* Header */}
        <View
          style={{
            paddingTop: insets.top,
            backgroundColor: isDark ? '#121215' : '#ffffff',
            borderBottomWidth: 1,
            borderBottomColor: isDark ? 'rgba(248, 248, 248, 0.1)' : 'rgba(18, 18, 21, 0.1)',
          }}
        >
          <Animated.View
            entering={FadeIn.duration(200)}
            className="px-4 py-3 flex-row items-center justify-between"
          >
            <View className="flex-row items-center gap-3 flex-1 min-w-0">
              <View
                className="rounded-xl p-2"
                style={{
                  backgroundColor: isDark ? 'rgba(248, 248, 248, 0.1)' : 'rgba(18, 18, 21, 0.06)',
                }}
              >
                <Icon as={Presentation} size={18} color={isDark ? '#f8f8f8' : '#121215'} />
              </View>

              {metadata && (
                <View className="flex-1 min-w-0">
                  <Text
                    className="text-base font-roobert-medium text-foreground"
                    numberOfLines={1}
                  >
                    {metadata.title || metadata.presentation_name}
                  </Text>
                  <Text className="text-xs font-roobert text-muted-foreground">
                    Slide {currentSlide} of {totalSlides}
                  </Text>
                </View>
              )}
            </View>

            <View className="flex-row items-center gap-1">
              {/* Export button */}
              <Pressable
                onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  setShowExportMenu(!showExportMenu);
                }}
                className="p-2.5 rounded-xl"
                style={{
                  backgroundColor: showExportMenu
                    ? (isDark ? 'rgba(248, 248, 248, 0.15)' : 'rgba(18, 18, 21, 0.08)')
                    : 'transparent',
                }}
                disabled={!metadata || isExporting !== null}
              >
                {isExporting ? (
                  <KortixLoader size="small" />
                ) : (
                  <Icon
                    as={Download}
                    size={20}
                    color={isDark ? '#f8f8f8' : '#121215'}
                    strokeWidth={2}
                  />
                )}
              </Pressable>

              {/* Close button */}
              <AnimatedPressable
                onPressIn={() => {
                  closeScale.value = withSpring(0.9, { damping: 15, stiffness: 400 });
                }}
                onPressOut={() => {
                  closeScale.value = withSpring(1, { damping: 15, stiffness: 400 });
                }}
                onPress={handleClose}
                style={closeAnimatedStyle}
                className="p-2.5"
              >
                <Icon
                  as={X}
                  size={22}
                  color={isDark ? '#f8f8f8' : '#121215'}
                  strokeWidth={2}
                />
              </AnimatedPressable>
            </View>
          </Animated.View>

          {/* Export dropdown */}
          {showExportMenu && (
            <View
              className="mx-4 mb-3 rounded-xl overflow-hidden"
              style={{
                backgroundColor: isDark ? 'rgba(248, 248, 248, 0.08)' : 'rgba(18, 18, 21, 0.04)',
                borderWidth: 1,
                borderColor: isDark ? 'rgba(248, 248, 248, 0.1)' : 'rgba(18, 18, 21, 0.08)',
              }}
            >
              <Pressable
                onPress={() => handleExportFile('pdf')}
                className="flex-row items-center gap-3 px-4 py-3"
                style={{
                  borderBottomWidth: 1,
                  borderBottomColor: isDark ? 'rgba(248, 248, 248, 0.08)' : 'rgba(18, 18, 21, 0.06)',
                }}
                disabled={isExporting !== null}
              >
                <Icon as={FileText} size={18} color={isDark ? '#f8f8f8' : '#121215'} />
                <Text className="text-sm font-roobert-medium text-foreground">
                  Export as PDF
                </Text>
              </Pressable>
              <Pressable
                onPress={() => handleExportFile('pptx')}
                className="flex-row items-center gap-3 px-4 py-3"
                style={{
                  borderBottomWidth: 1,
                  borderBottomColor: isDark ? 'rgba(248, 248, 248, 0.08)' : 'rgba(18, 18, 21, 0.06)',
                }}
                disabled={isExporting !== null}
              >
                <Icon as={FileIcon} size={18} color={isDark ? '#f8f8f8' : '#121215'} />
                <Text className="text-sm font-roobert-medium text-foreground">
                  Export as PPTX
                </Text>
              </Pressable>
              <Pressable
                onPress={handleExportGoogleSlides}
                className="flex-row items-center gap-3 px-4 py-3"
                disabled={isExporting !== null}
              >
                <Icon as={ExternalLink} size={18} color={isDark ? '#f8f8f8' : '#121215'} />
                <Text className="text-sm font-roobert-medium text-foreground">
                  Upload to Google Slides
                </Text>
              </Pressable>
            </View>
          )}
        </View>

        {/* Main Content Area */}
        <View
          className="flex-1 items-center justify-center px-4"
          style={{ backgroundColor: isDark ? '#0a0a0c' : '#f4f4f5' }}
          onLayout={handleContainerLayout}
        >
          {isLoading || !currentSlideData ? (
            <View className="items-center justify-center">
              <KortixLoader size="large" />
              <Text className="text-base font-roobert-medium text-foreground mt-4">
                {retryAttempt > 0 ? `Retrying... (${retryAttempt + 1})` : 'Loading...'}
              </Text>
            </View>
          ) : (
            <View
              style={{
                width: slideWidth,
                aspectRatio: 16 / 9,
                borderRadius: 12,
                overflow: 'hidden',
                backgroundColor: 'white',
                shadowColor: '#000',
                shadowOffset: { width: 0, height: 8 },
                shadowOpacity: isDark ? 0.4 : 0.15,
                shadowRadius: 24,
                elevation: 12,
              }}
            >
              <View
                style={{
                  width: 1920,
                  height: 1080,
                  transform: [{ scale }],
                  transformOrigin: 'top left',
                }}
              >
                <WebView
                  key={`fullscreen-slide-${currentSlide}-${refreshTimestamp}`}
                  source={{
                    uri: `${constructHtmlPreviewUrl(sandboxUrl!, currentSlideData.file_path)}?t=${refreshTimestamp}`,
                  }}
                  scrollEnabled={false}
                  showsVerticalScrollIndicator={false}
                  showsHorizontalScrollIndicator={false}
                  style={{ width: 1920, height: 1080, backgroundColor: 'white' }}
                  originWhitelist={['*']}
                  javaScriptEnabled={true}
                  domStorageEnabled={true}
                  injectedJavaScript={injectedJS}
                  onMessage={() => { }}
                />
              </View>
            </View>
          )}
        </View>

        {/* Bottom Controls */}
        <View
          style={{
            paddingBottom: insets.bottom + 8,
            backgroundColor: isDark ? '#121215' : '#ffffff',
            borderTopWidth: 1,
            borderTopColor: isDark ? 'rgba(248, 248, 248, 0.1)' : 'rgba(18, 18, 21, 0.1)',
          }}
        >
          <View className="px-4 py-3 flex-row items-center justify-between">
            {/* Left Controls */}
            <View className="flex-row items-center gap-1">
              <Pressable
                onPress={goToFirstSlide}
                disabled={currentSlide <= 1}
                className="p-2.5 rounded-xl"
                style={{
                  opacity: currentSlide <= 1 ? 0.3 : 1,
                  backgroundColor: isDark ? 'rgba(248, 248, 248, 0.08)' : 'rgba(18, 18, 21, 0.04)',
                }}
              >
                <Icon
                  as={SkipBack}
                  size={16}
                  color={isDark ? '#f8f8f8' : '#121215'}
                  strokeWidth={2}
                />
              </Pressable>

              <Pressable
                onPress={goToPreviousSlide}
                disabled={currentSlide <= 1}
                className="p-2.5 rounded-xl"
                style={{ opacity: currentSlide <= 1 ? 0.3 : 1 }}
              >
                <Icon
                  as={ChevronLeft}
                  size={22}
                  color={isDark ? '#f8f8f8' : '#121215'}
                  strokeWidth={2}
                />
              </Pressable>
            </View>

            {/* Center - Slide Indicators */}
            <View className="flex-1 items-center justify-center">
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={{
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 6,
                }}
              >
                {slides.map((slide) => (
                  <Pressable
                    key={slide.number}
                    onPress={() => {
                      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                      setCurrentSlide(slide.number);
                    }}
                  >
                    <View
                      style={{
                        width: slide.number === currentSlide ? 20 : 6,
                        height: 6,
                        borderRadius: 3,
                        backgroundColor:
                          slide.number === currentSlide
                            ? (isDark ? '#f8f8f8' : '#121215')
                            : (isDark ? 'rgba(248, 248, 248, 0.25)' : 'rgba(18, 18, 21, 0.15)'),
                      }}
                    />
                  </Pressable>
                ))}
              </ScrollView>
            </View>

            {/* Right Controls */}
            <View className="flex-row items-center gap-1">
              <Pressable
                onPress={goToNextSlide}
                disabled={currentSlide >= totalSlides}
                className="p-2.5 rounded-xl"
                style={{ opacity: currentSlide >= totalSlides ? 0.3 : 1 }}
              >
                <Icon
                  as={ChevronRight}
                  size={22}
                  color={isDark ? '#f8f8f8' : '#121215'}
                  strokeWidth={2}
                />
              </Pressable>

              <Pressable
                onPress={goToLastSlide}
                disabled={currentSlide >= totalSlides}
                className="p-2.5 rounded-xl"
                style={{
                  opacity: currentSlide >= totalSlides ? 0.3 : 1,
                  backgroundColor: isDark ? 'rgba(248, 248, 248, 0.08)' : 'rgba(18, 18, 21, 0.04)',
                }}
              >
                <Icon
                  as={SkipForward}
                  size={16}
                  color={isDark ? '#f8f8f8' : '#121215'}
                  strokeWidth={2}
                />
              </Pressable>
            </View>
          </View>
        </View>
      </View>
    </Modal>
  );
}
