import * as React from 'react';
import { View, ScrollView, Pressable, TextInput, ActivityIndicator, Alert } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { 
  ArrowLeft, 
  Globe, 
  CheckCircle2,
  AlertCircle,
  Info
} from 'lucide-react-native';
import { SettingsHeader } from '../SettingsHeader';
import { useLanguage } from '@/contexts';
import { 
  useDiscoverCustomMcpTools,
  type CustomMcpResponse
} from '@/hooks/useCustomMcp';
import * as Haptics from 'expo-haptics';
import Animated, { 
  useAnimatedStyle, 
  useSharedValue, 
  withSpring 
} from 'react-native-reanimated';
import { CustomMcpToolsSelector } from './CustomMcpToolsSelector';

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
}

export function CustomMcpContent({ onBack, noPadding = false, onSave }: CustomMcpContentProps) {
  const { t } = useLanguage();
  const { mutate: discoverTools, isPending: isValidating } = useDiscoverCustomMcpTools();
  
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

    console.log('🎯 Discovering tools for URL:', url);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    
    setValidationError(null);
    
    discoverTools({
      type: 'http',
      config: { url: url.trim() }
    }, {
      onSuccess: (response: CustomMcpResponse) => {
        console.log('✅ Tools discovered:', response);
        
        if (!response.tools || response.tools.length === 0) {
          setValidationError(t('integrations.customMcp.noToolsFound'));
          return;
        }

        const finalServerName = response.serverName || manualServerName.trim();
        setServerName(finalServerName);
        setDiscoveredTools(response.tools);
        setSelectedTools(new Set(response.tools.map(tool => tool.name)));
        
        // Pass the config to onSave for AgentDrawer flow
        onSave?.({
          serverName: finalServerName,
          url: url.trim(),
          type: 'http' as const,
          tools: response.tools
        });
        setStep('tools');
      },
      onError: (error) => {
        console.error('❌ Failed to discover tools:', error);
        setValidationError(error.message || t('integrations.customMcp.failedToConnect'));
      },
    });
  }, [url, manualServerName, validateUrl, discoverTools, isValidating, onSave, t]);

  const handleBackToConfig = React.useCallback(() => {
    console.log('🎯 Back to configuration');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setStep('config');
  }, []);

  const handleToolsComplete = React.useCallback((enabledTools: string[]) => {
    console.log('✅ Custom MCP configuration completed');
    const config = {
      serverName: serverName,
      url: url.trim(),
      type: 'http' as const,
      tools: enabledTools,
      discoveredTools: discoveredTools
    };
    onSave?.(config);
    Alert.alert(t('integrations.customMcp.toolsConfigured'), t('integrations.customMcp.toolsConfiguredMessage', { count: enabledTools.length }));
  }, [serverName, url, discoveredTools, onSave, t]);

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
          <View className={noPadding ? "pb-6" : "px-6 pb-6"}>
            {onBack && (
              <Pressable
                onPress={onBack}
                className="items-center justify-center w-10 h-10 mb-4 active:opacity-70 rounded-full bg-primary/10"
              >
                <ArrowLeft size={20} className="text-foreground" />
              </Pressable>
            )}
            
            <View className="mb-8">
              <View className="flex-row items-center gap-4 mb-2">
                <View className="w-14 h-14 rounded-2xl bg-primary/5 items-center justify-center">
                  <Icon as={Globe} size={24} className="text-primary" />
                </View>
                <View className="flex-1">
                  <Text className="text-2xl font-roobert-bold text-foreground">
                    {t('integrations.customMcp.title')}
                  </Text>
                </View>
              </View>
              <Text className="text-base font-roobert text-muted-foreground mt-2">
                {t('integrations.customMcp.description')}
              </Text>
            </View>

            <View className="space-y-6">
              <View>
                <Text className="text-sm font-roobert-medium text-muted-foreground mb-3 uppercase tracking-wider">
                  {t('integrations.customMcp.serverUrl')}
                </Text>
                <TextInput
                  value={url}
                  onChangeText={(text) => {
                    setUrl(text);
                    if (validationError) setValidationError(null);
                  }}
                  placeholder={t('integrations.customMcp.serverUrlPlaceholder')}
                  className="bg-muted/5 rounded-2xl px-4 py-4 text-base font-roobert text-foreground border border-border/40"
                  placeholderTextColor="rgba(156, 163, 175, 0.5)"
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                />
              </View>

              <View className='mt-4 mb-6'>
                <Text className="text-sm font-roobert-medium text-muted-foreground mb-3 uppercase tracking-wider">
                  {t('integrations.customMcp.serverName')}
                </Text>
                <TextInput
                  value={manualServerName}
                  onChangeText={(text) => {
                    setManualServerName(text);
                    if (validationError) setValidationError(null);
                  }}
                  placeholder={t('integrations.customMcp.serverNamePlaceholder')}
                  className="bg-muted/5 rounded-2xl px-4 py-4 text-base font-roobert text-foreground border border-border/40"
                  placeholderTextColor="rgba(156, 163, 175, 0.5)"
                />
              </View>

              {validationError && (
                <View className="mt-3 mb-6">
                  <Text className="text-sm font-roobert text-red-600 mb-2">
                    {validationError}
                  </Text>
                </View>
              )}

              <ContinueButton
                onPress={handleDiscoverTools}
                disabled={isValidating || !url.trim() || !manualServerName.trim()}
                label={isValidating ? t('integrations.customMcp.discoveringTools') : t('integrations.customMcp.discoverTools')}
                isLoading={isValidating}
              />
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
    console.log('🎯 Custom MCP dialog closing');
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

    console.log('🎯 Discovering tools for URL:', url);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    
    setValidationError(null);
    
    discoverTools({
      type: 'http',
      config: { url: url.trim() }
    }, {
      onSuccess: (response: CustomMcpResponse) => {
        console.log('✅ Tools discovered:', response);
        
        if (!response.tools || response.tools.length === 0) {
          setValidationError(t('integrations.customMcp.noToolsFound'));
          return;
        }

        setServerName(response.serverName || manualServerName.trim());
        setDiscoveredTools(response.tools);
        setSelectedTools(new Set(response.tools.map(tool => tool.name)));
        setStep('tools');
      },
      onError: (error) => {
        console.error('❌ Failed to discover tools:', error);
        setValidationError(error.message || t('integrations.customMcp.failedToConnect'));
      },
    });
  }, [url, manualServerName, validateUrl, discoverTools, t]);

  const handleBackToConfig = React.useCallback(() => {
    console.log('🎯 Back to configuration');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setStep('config');
  }, []);

  const handleToolsComplete = React.useCallback((enabledTools: string[]) => {
    console.log('✅ Custom MCP configuration completed');
    
    const config = {
      name: serverName,
      type: 'http',
      config: { url: url.trim() },
      enabledTools,
    };
    
    onSave(config);
    handleClose();
    
    Alert.alert(t('integrations.customMcp.toolsConfigured'), t('integrations.customMcp.toolsConfiguredMessage', { count: enabledTools.length }));
  }, [serverName, url, onSave, handleClose, t]);

  if (!open) return null;

  return (
    <View className="absolute inset-0 z-50">
      <Pressable
        onPress={handleClose}
        className="absolute inset-0 bg-black/50"
      />
      <View className="absolute top-0 left-0 right-0 bottom-0 bg-background">
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
            <SettingsHeader
              title={t('integrations.customMcp.title')}
              onClose={handleClose}
            />
            
            <ScrollView 
              className="flex-1" 
              showsVerticalScrollIndicator={false}
            >
              
              <View className="px-6 pb-6">
            <View className="mb-8">
              <View className="flex-row items-center gap-4 mb-2">
                <View className="w-14 h-14 rounded-2xl bg-primary/5 items-center justify-center">
                  <Icon as={Globe} size={24} className="text-primary" />
                </View>
                <View className="flex-1">
                  <Text className="text-2xl font-roobert-bold text-foreground">
                    {t('integrations.customMcp.title')}
                  </Text>
                </View>
              </View>
              <Text className="text-base font-roobert text-muted-foreground mt-2">
                {t('integrations.customMcp.description')}
              </Text>
            </View>

            <View className="space-y-6">
              <View>
                <Text className="text-sm font-roobert-medium text-muted-foreground mb-3 uppercase tracking-wider">
                  {t('integrations.customMcp.serverUrl')}
                </Text>
                <TextInput
                  value={url}
                  onChangeText={(text) => {
                    setUrl(text);
                    setValidationError(null);
                  }}
                  placeholder={t('integrations.customMcp.serverUrlPlaceholder')}
                  className="bg-muted/5 rounded-2xl px-4 py-4 text-base font-roobert text-foreground border border-border/40"
                  placeholderTextColor="rgba(156, 163, 175, 0.5)"
                  keyboardType="url"
                  autoCapitalize="none"
                  autoCorrect={false}
                />
              </View>

              <View>
                <Text className="text-sm font-roobert-medium text-muted-foreground mb-3 uppercase tracking-wider">
                  {t('integrations.customMcp.serverName')}
                </Text>
                <TextInput
                  value={manualServerName}
                  onChangeText={(text) => {
                    setManualServerName(text);
                    setValidationError(null);
                  }}
                  placeholder={t('integrations.customMcp.serverNamePlaceholder')}
                  className="bg-muted/5 rounded-2xl px-4 py-4 text-base font-roobert text-foreground border border-border/40"
                  placeholderTextColor="rgba(156, 163, 175, 0.5)"
                />
              </View>

              {validationError && (
                <View className="mt-3">
                  <Text className="text-sm font-roobert text-red-600 mb-2">
                    {validationError}
                  </Text>
                </View>
              )}

              <ContinueButton
                onPress={handleDiscoverTools}
                disabled={isValidating || !url.trim() || !manualServerName.trim()}
                label={isValidating ? t('integrations.customMcp.discoveringTools') : t('integrations.customMcp.discoverTools')}
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

const ContinueButton = React.memo(({ 
  onPress, 
  disabled = false, 
  label, 
  isLoading = false,
  rounded = 'full'
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
      className={`w-full py-4 items-center ${rounded === 'full' ? 'rounded-full' : 'rounded-2xl'} ${
        disabled ? 'bg-muted/20' : 'bg-foreground'
      }`}
    >
      <View className="flex-row items-center gap-2">
        {isLoading && <ActivityIndicator size="small" color="#fff" />}
        <Text className={`text-base font-roobert-semibold ${
          disabled ? 'text-muted-foreground' : 'text-background'
        }`}>
          {label}
        </Text>
      </View>
    </AnimatedPressable>
  );
});
