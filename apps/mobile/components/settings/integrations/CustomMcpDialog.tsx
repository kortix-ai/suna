import * as React from 'react';
import { View, ScrollView, Pressable, ActivityIndicator, Alert } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { ArrowLeft, Globe, CheckCircle2, AlertCircle, Info } from 'lucide-react-native';
import { useColorScheme } from 'nativewind';
import { useLanguage } from '@/contexts';
import { useDiscoverCustomMcpTools, type CustomMcpResponse } from '@/hooks/useCustomMcp';
import * as Haptics from 'expo-haptics';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { CustomMcpToolsSelector } from './CustomMcpToolsSelector';
import { log } from '@/lib/logger';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

interface CustomMcpDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (config: any) => void;
}

interface CustomMcpContentProps {
  onBack?: () => void;
  noPadding?: boolean;
  onSave?: (config: any) => void;
  hideBackButton?: boolean;
  hideButton?: boolean;
  onDiscoverToolsPress?: () => void;
  buttonDisabled?: boolean;
  isValidating?: boolean;
  onDiscoverToolsReady?: (handler: () => void, disabled: boolean, loading: boolean) => void;
}

export function CustomMcpContent({
  onBack,
  noPadding = false,
  onSave,
  hideBackButton = false,
  hideButton = false,
  onDiscoverToolsPress,
  buttonDisabled,
  isValidating: externalIsValidating,
  onDiscoverToolsReady,
}: CustomMcpContentProps) {
  const { t } = useLanguage();
  const { colorScheme } = useColorScheme();
  const { mutate: discoverTools, isPending: internalIsValidating } = useDiscoverCustomMcpTools();
  const isValidating =
    externalIsValidating !== undefined ? externalIsValidating : internalIsValidating;

  const [step, setStep] = React.useState<'config' | 'tools'>('config');
  const [url, setUrl] = React.useState('');
  const [serverName, setServerName] = React.useState('');
  const [manualServerName, setManualServerName] = React.useState('');
  const [validationError, setValidationError] = React.useState<string | null>(null);
  const [discoveredTools, setDiscoveredTools] = React.useState<any[]>([]);
  const [selectedTools, setSelectedTools] = React.useState<Set<string>>(new Set());

  const validateUrl = React.useCallback((urlString: string): boolean => {
    try {
      const url = new URL(urlString);
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
      return false;
    }
  }, []);

  const handleDiscoverTools = React.useCallback(() => {
    if (isValidating) {
      return;
    }

    if (!validateUrl(url.trim())) {
      setValidationError(t('integrations.customMcp.enterValidUrl'));
      return;
    }

    if (!manualServerName.trim()) {
      setValidationError(t('integrations.customMcp.enterServerName'));
      return;
    }

    log.log('🎯 Discovering tools for URL:', url);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

    setValidationError(null);

    discoverTools(
      {
        type: 'http',
        config: { url: url.trim() },
      },
      {
        onSuccess: (response: CustomMcpResponse) => {
          log.log('✅ Tools discovered:', response);

          if (!response.tools || response.tools.length === 0) {
            setValidationError(t('integrations.customMcp.noToolsFound'));
            return;
          }

          const finalServerName = response.serverName || manualServerName.trim();
          setServerName(finalServerName);
          setDiscoveredTools(response.tools);
          setSelectedTools(new Set(response.tools.map((tool) => tool.name)));

          // Pass the config to onSave for AgentDrawer flow
          onSave?.({
            serverName: finalServerName,
            url: url.trim(),
            type: 'http' as const,
            tools: response.tools,
          });
          setStep('tools');
        },
        onError: (error) => {
          log.error('❌ Failed to discover tools:', error);
          setValidationError(error.message || t('integrations.customMcp.failedToConnect'));
        },
      }
    );
  }, [url, manualServerName, validateUrl, discoverTools, isValidating, onSave, t]);

  const handleBackToConfig = React.useCallback(() => {
    log.log('🎯 Back to configuration');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setStep('config');
  }, []);

  const handleToolsComplete = React.useCallback(
    (enabledTools: string[]) => {
      log.log('✅ Custom MCP configuration completed');
      const config = {
        serverName: serverName,
        url: url.trim(),
        type: 'http' as const,
        tools: enabledTools,
        discoveredTools: discoveredTools,
      };
      onSave?.(config);
      Alert.alert(
        t('integrations.customMcp.toolsConfigured'),
        t('integrations.customMcp.toolsConfiguredMessage', { count: enabledTools.length })
      );
    },
    [serverName, url, discoveredTools, onSave, t]
  );

  // Store handler in ref to avoid recreating it
  const handleDiscoverToolsRef = React.useRef(handleDiscoverTools);
  React.useEffect(() => {
    handleDiscoverToolsRef.current = handleDiscoverTools;
  }, [handleDiscoverTools]);

  // Expose handler to parent for fixed footer button
  React.useEffect(() => {
    if (onDiscoverToolsReady && step === 'config') {
      const isDisabled = isValidating || !url.trim() || !manualServerName.trim();
      onDiscoverToolsReady(() => handleDiscoverToolsRef.current(), isDisabled, isValidating);
    }
  }, [onDiscoverToolsReady, step, url, manualServerName, isValidating]);

  return (
    <>
      {step === 'tools' ? (
        <CustomMcpToolsSelector
          serverName={serverName}
          url={url}
          tools={discoveredTools}
          selectedTools={selectedTools}
          onSelectedToolsChange={setSelectedTools}
          onClose={handleBackToConfig}
          onComplete={handleToolsComplete}
        />
      ) : (
        <View className="flex-1">
          {/* Header with back button, title, and description */}
          {!hideBackButton && (
            <View className="mb-4 flex-row items-center">
              {onBack && (
                <Pressable onPress={onBack} className="flex-row items-center active:opacity-70">
                  <ArrowLeft size={20} color={colorScheme === 'dark' ? '#f8f8f8' : '#121215'} />
                </Pressable>
              )}
              <View className="ml-3 flex-1">
                <Text
                  style={{ color: colorScheme === 'dark' ? '#f8f8f8' : '#121215' }}
                  className="font-roobert-semibold text-xl">
                  {t('integrations.customMcp.title')}
                </Text>
                <Text
                  style={{
                    color:
                      colorScheme === 'dark' ? 'rgba(248, 248, 248, 0.6)' : 'rgba(18, 18, 21, 0.6)',
                  }}
                  className="font-roobert text-sm">
                  {t('integrations.customMcp.description')}
                </Text>
              </View>
            </View>
          )}

          <View className={noPadding ? 'pb-6' : 'pb-6'}>
            <View className="space-y-6">
              <Input
                label={t('integrations.customMcp.serverUrl')}
                value={url}
                onChangeText={(text) => {
                  setUrl(text);
                  if (validationError) setValidationError(null);
                }}
                placeholder={t('integrations.customMcp.serverUrlPlaceholder')}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
              />

              <Input
                label={t('integrations.customMcp.serverName')}
                value={manualServerName}
                onChangeText={(text) => {
                  setManualServerName(text);
                  if (validationError) setValidationError(null);
                }}
                placeholder={t('integrations.customMcp.serverNamePlaceholder')}
                containerClassName="mt-4 mb-6"
              />

              {validationError && (
                <View className="mb-6 mt-3">
                  <Text className="mb-2 font-roobert text-sm text-red-600">{validationError}</Text>
                </View>
              )}

              {!hideButton && (
                <ContinueButton
                  onPress={onDiscoverToolsPress || handleDiscoverTools}
                  disabled={
                    buttonDisabled !== undefined
                      ? buttonDisabled
                      : isValidating || !url.trim() || !manualServerName.trim()
                  }
                  label={
                    isValidating
                      ? t('integrations.customMcp.discoveringTools')
                      : t('integrations.customMcp.discoverTools')
                  }
                  isLoading={isValidating}
                />
              )}
            </View>
          </View>

          <View className="h-20" />
        </View>
      )}
    </>
  );
}

export function CustomMcpDialog({ open, onOpenChange, onSave }: CustomMcpDialogProps) {
  const { t } = useLanguage();
  const { colorScheme } = useColorScheme();
  const { mutate: discoverTools, isPending: isValidating } = useDiscoverCustomMcpTools();

  const [step, setStep] = React.useState<'config' | 'tools'>('config');
  const [url, setUrl] = React.useState('');
  const [serverName, setServerName] = React.useState('');
  const [manualServerName, setManualServerName] = React.useState('');
  const [validationError, setValidationError] = React.useState<string | null>(null);
  const [discoveredTools, setDiscoveredTools] = React.useState<any[]>([]);
  const [selectedTools, setSelectedTools] = React.useState<Set<string>>(new Set());

  React.useEffect(() => {
    if (!open) {
      const timer = setTimeout(() => {
        setStep('config');
        setUrl('');
        setServerName('');
        setManualServerName('');
        setValidationError(null);
        setDiscoveredTools([]);
        setSelectedTools(new Set());
      }, 350);
      return () => clearTimeout(timer);
    }
  }, [open]);

  const handleClose = React.useCallback(() => {
    log.log('🎯 Custom MCP dialog closing');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onOpenChange(false);
  }, [onOpenChange]);

  const validateUrl = React.useCallback((urlString: string) => {
    try {
      const urlObj = new URL(urlString);
      return urlObj.protocol === 'http:' || urlObj.protocol === 'https:';
    } catch {
      return false;
    }
  }, []);

  const handleDiscoverTools = React.useCallback(() => {
    if (!url.trim()) {
      setValidationError(t('integrations.customMcp.enterValidUrl'));
      return;
    }

    if (!validateUrl(url.trim())) {
      setValidationError(t('integrations.customMcp.enterValidUrl'));
      return;
    }

    if (!manualServerName.trim()) {
      setValidationError(t('integrations.customMcp.enterServerName'));
      return;
    }

    log.log('🎯 Discovering tools for URL:', url);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

    setValidationError(null);

    discoverTools(
      {
        type: 'http',
        config: { url: url.trim() },
      },
      {
        onSuccess: (response: CustomMcpResponse) => {
          log.log('✅ Tools discovered:', response);

          if (!response.tools || response.tools.length === 0) {
            setValidationError(t('integrations.customMcp.noToolsFound'));
            return;
          }

          setServerName(response.serverName || manualServerName.trim());
          setDiscoveredTools(response.tools);
          setSelectedTools(new Set(response.tools.map((tool) => tool.name)));
          setStep('tools');
        },
        onError: (error) => {
          log.error('❌ Failed to discover tools:', error);
          setValidationError(error.message || t('integrations.customMcp.failedToConnect'));
        },
      }
    );
  }, [url, manualServerName, validateUrl, discoverTools, t]);

  const handleBackToConfig = React.useCallback(() => {
    log.log('🎯 Back to configuration');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setStep('config');
  }, []);

  const handleToolsComplete = React.useCallback(
    (enabledTools: string[]) => {
      log.log('✅ Custom MCP configuration completed');

      const config = {
        name: serverName,
        type: 'http',
        config: { url: url.trim() },
        enabledTools,
      };

      onSave(config);
      handleClose();

      Alert.alert(
        t('integrations.customMcp.toolsConfigured'),
        t('integrations.customMcp.toolsConfiguredMessage', { count: enabledTools.length })
      );
    },
    [serverName, url, onSave, handleClose, t]
  );

  if (!open) return null;

  return (
    <View className="absolute inset-0 z-50">
      <Pressable onPress={handleClose} className="absolute inset-0 bg-black/50" />
      <View className="absolute bottom-0 left-0 right-0 top-0 bg-background">
        {step === 'tools' ? (
          <CustomMcpToolsSelector
            serverName={serverName}
            url={url}
            tools={discoveredTools}
            selectedTools={selectedTools}
            onSelectedToolsChange={setSelectedTools}
            onClose={handleBackToConfig}
            onComplete={handleToolsComplete}
          />
        ) : (
          <>
            <ScrollView className="flex-1" showsVerticalScrollIndicator={false}>
              <View className="px-6 pb-6">
                {/* Header with back button, title, and description */}
                <View className="mb-4 mt-4 flex-row items-center">
                  <Pressable
                    onPress={handleClose}
                    className="flex-row items-center active:opacity-70">
                    <ArrowLeft size={20} color={colorScheme === 'dark' ? '#f8f8f8' : '#121215'} />
                  </Pressable>
                  <View className="ml-3 flex-1">
                    <Text
                      style={{ color: colorScheme === 'dark' ? '#f8f8f8' : '#121215' }}
                      className="font-roobert-semibold text-xl">
                      {t('integrations.customMcp.title')}
                    </Text>
                    <Text
                      style={{
                        color:
                          colorScheme === 'dark'
                            ? 'rgba(248, 248, 248, 0.6)'
                            : 'rgba(18, 18, 21, 0.6)',
                      }}
                      className="font-roobert text-sm">
                      {t('integrations.customMcp.description')}
                    </Text>
                  </View>
                </View>

                <View className="space-y-6">
                  <Input
                    label={t('integrations.customMcp.serverUrl')}
                    value={url}
                    onChangeText={(text) => {
                      setUrl(text);
                      setValidationError(null);
                    }}
                    placeholder={t('integrations.customMcp.serverUrlPlaceholder')}
                    keyboardType="url"
                    autoCapitalize="none"
                    autoCorrect={false}
                  />

                  <Input
                    label={t('integrations.customMcp.serverName')}
                    value={manualServerName}
                    onChangeText={(text) => {
                      setManualServerName(text);
                      setValidationError(null);
                    }}
                    placeholder={t('integrations.customMcp.serverNamePlaceholder')}
                  />

                  {validationError && (
                    <View className="mt-3">
                      <Text className="mb-2 font-roobert text-sm text-red-600">
                        {validationError}
                      </Text>
                    </View>
                  )}

                  <ContinueButton
                    onPress={handleDiscoverTools}
                    disabled={isValidating || !url.trim() || !manualServerName.trim()}
                    label={
                      isValidating
                        ? t('integrations.customMcp.discoveringTools')
                        : t('integrations.customMcp.discoverTools')
                    }
                    isLoading={isValidating}
                    rounded="2xl"
                  />
                </View>
              </View>
              <View className="h-20" />
            </ScrollView>
          </>
        )}
      </View>
    </View>
  );
}

interface ContinueButtonProps {
  onPress: () => void;
  disabled?: boolean;
  label: string;
  isLoading?: boolean;
  rounded?: 'full' | '2xl';
}

const ContinueButton = React.memo(
  ({
    onPress,
    disabled = false,
    label,
    isLoading = false,
    rounded = 'full',
  }: ContinueButtonProps) => {
    const scale = useSharedValue(1);

    const animatedStyle = useAnimatedStyle(() => ({
      transform: [{ scale: scale.value }],
    }));

    const handlePressIn = React.useCallback(() => {
      if (!disabled) {
        scale.value = withSpring(0.97, { damping: 15, stiffness: 400 });
      }
    }, [scale, disabled]);

    const handlePressOut = React.useCallback(() => {
      scale.value = withSpring(1, { damping: 15, stiffness: 400 });
    }, [scale]);

    return (
      <AnimatedPressable
        onPress={onPress}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        style={animatedStyle}
        disabled={disabled}
        className={`w-full items-center py-4 ${rounded === 'full' ? 'rounded-full' : 'rounded-2xl'} ${
          disabled ? 'bg-muted/20' : 'bg-foreground'
        }`}>
        <View className="flex-row items-center gap-2">
          {isLoading && <ActivityIndicator size="small" color="#fff" />}
          <Text
            className={`font-roobert-semibold text-base ${
              disabled ? 'text-muted-foreground' : 'text-background'
            }`}>
            {label}
          </Text>
        </View>
      </AnimatedPressable>
    );
  }
);
