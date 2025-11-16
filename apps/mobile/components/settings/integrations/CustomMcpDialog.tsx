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
      setValidationError('Please enter a valid HTTP or HTTPS URL.');
      return;
    }

    if (!manualServerName.trim()) {
      setValidationError('Please enter a name for this MCP server.');
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
          setValidationError('No tools found. Please check your configuration.');
          return;
        }

        setServerName(response.serverName || manualServerName.trim());
        setDiscoveredTools(response.tools);
        setSelectedTools(new Set(response.tools.map(tool => tool.name)));
        setStep('tools');
      },
      onError: (error) => {
        console.error('❌ Failed to discover tools:', error);
        setValidationError(error.message || 'Failed to connect to the MCP server. Please check your configuration.');
      },
    });
  }, [url, manualServerName, validateUrl, discoverTools, isValidating]);

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
      tools: enabledTools
    };
    
    onSave?.(config);
    Alert.alert('Custom MCP Added', `${enabledTools.length} tools configured`);
  }, [serverName, url, onSave]);

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
            
            <Text className="text-2xl font-roobert-bold text-foreground mb-2">
              Add Custom MCP Server
            </Text>
            
            <View className="items-center py-6">
              <View className="h-16 w-16 rounded-2xl bg-orange-100 dark:bg-orange-900/30 items-center justify-center mb-4">
                <Icon as={Globe} size={24} className="text-orange-600" />
              </View>
              
              <Text className="text-xl font-roobert-semibold text-foreground text-center mb-2">
                Custom MCP Integration
              </Text>
              
              <Text className="text-sm font-roobert text-muted-foreground text-center">
                Connect to a custom Model Control Protocol server via HTTP
              </Text>
            </View>

            <View className="space-y-6">
              <View className="space-y-2">
                <Text className="text-sm font-roobert-medium text-foreground">
                  Server URL
                </Text>
                <TextInput
                  value={url}
                  onChangeText={(text) => {
                    setUrl(text);
                    if (validationError) setValidationError(null);
                  }}
                  placeholder="https://your-mcp-server.com"
                  className="bg-muted/20 border border-border rounded-xl px-4 py-3 text-foreground font-roobert"
                  placeholderTextColor="#888888"
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                />
              </View>

              <View className="space-y-2">
                <Text className="text-sm font-roobert-medium text-foreground">
                  Server Name
                </Text>
                <TextInput
                  value={manualServerName}
                  onChangeText={(text) => {
                    setManualServerName(text);
                    if (validationError) setValidationError(null);
                  }}
                  placeholder="My Custom Server"
                  className="bg-muted/20 border border-border rounded-xl px-4 py-3 text-foreground font-roobert"
                  placeholderTextColor="#888888"
                />
              </View>

              {validationError && (
                <View className="bg-destructive/10 border border-destructive/20 rounded-xl p-4">
                  <View className="flex-row items-center gap-2">
                    <Icon as={AlertCircle} size={16} className="text-destructive" />
                    <Text className="text-sm font-roobert-medium text-destructive">
                      Configuration Error
                    </Text>
                  </View>
                  <Text className="text-sm font-roobert text-destructive/80 mt-1">
                    {validationError}
                  </Text>
                </View>
              )}

              <View className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-xl p-4">
                <View className="flex-row items-start gap-3">
                  <Icon as={Info} size={16} className="text-blue-600 mt-0.5" />
                  <View className="flex-1">
                    <Text className="text-sm font-roobert-medium text-blue-900 dark:text-blue-100 mb-1">
                      MCP Server Requirements
                    </Text>
                    <Text className="text-sm font-roobert text-blue-800 dark:text-blue-200">
                      • Must be accessible via HTTP/HTTPS{'\n'}
                      • Should implement MCP protocol correctly{'\n'}
                      • Must respond to tool discovery requests
                    </Text>
                  </View>
                </View>
              </View>

              <ActionButton
                title={isValidating ? "Discovering Tools..." : "Discover Tools"}
                description="Connect to the server and discover available tools"
                onPress={handleDiscoverTools}
                disabled={isValidating || !url.trim() || !manualServerName.trim()}
                loading={isValidating}
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
      setValidationError('Please enter the MCP server URL.');
      return;
    }

    if (!validateUrl(url.trim())) {
      setValidationError('Please enter a valid HTTP or HTTPS URL.');
      return;
    }

    if (!manualServerName.trim()) {
      setValidationError('Please enter a name for this MCP server.');
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
          setValidationError('No tools found. Please check your configuration.');
          return;
        }

        setServerName(response.serverName || manualServerName.trim());
        setDiscoveredTools(response.tools);
        setSelectedTools(new Set(response.tools.map(tool => tool.name)));
        setStep('tools');
      },
      onError: (error) => {
        console.error('❌ Failed to discover tools:', error);
        setValidationError(error.message || 'Failed to connect to the MCP server. Please check your configuration.');
      },
    });
  }, [url, manualServerName, validateUrl, discoverTools]);

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
    
    Alert.alert('Custom MCP Added', `${enabledTools.length} tools configured`);
  }, [serverName, url, onSave, handleClose]);

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
              title="Add Custom MCP Server"
              onClose={handleClose}
            />
            
            <ScrollView 
              className="flex-1" 
              showsVerticalScrollIndicator={false}
            >
              
              <View className="px-6 pb-6">
            <View className="items-center py-6">
              <View className="h-16 w-16 rounded-2xl bg-orange-100 dark:bg-orange-900/30 items-center justify-center mb-4">
                <Icon as={Globe} size={24} className="text-orange-600" />
              </View>
              
              <Text className="text-xl font-roobert-semibold text-foreground text-center mb-2">
                Custom MCP Integration
              </Text>
              
              <Text className="text-sm font-roobert text-muted-foreground text-center">
                Connect to a custom Model Control Protocol server via HTTP
              </Text>
            </View>

            <View className="space-y-6">
              <View className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800/30 rounded-2xl p-4">
                <View className="flex-row items-start gap-3">
                  <Icon as={Info} size={16} className="text-blue-600 mt-0.5" />
                  <View className="flex-1">
                    <Text className="text-sm font-roobert-medium text-blue-900 dark:text-blue-100">
                      What is MCP?
                    </Text>
                    <Text className="text-sm font-roobert text-blue-700 dark:text-blue-200 mt-1">
                      Model Control Protocol allows you to connect custom tools and services to your agent via HTTP endpoints.
                    </Text>
                  </View>
                </View>
              </View>

              <View>
                <Text className="text-base font-roobert-medium text-foreground mb-3">
                  Server URL
                </Text>
                <TextInput
                  value={url}
                  onChangeText={(text) => {
                    setUrl(text);
                    setValidationError(null);
                  }}
                  placeholder="https://your-mcp-server.com"
                  className="bg-muted/10 dark:bg-muted/30 rounded-xl px-4 py-3 text-base font-roobert text-foreground"
                  placeholderTextColor="rgba(156, 163, 175, 0.6)"
                  keyboardType="url"
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                <Text className="text-sm font-roobert text-muted-foreground mt-2">
                  Enter the HTTP(S) URL of your MCP server endpoint.
                </Text>
              </View>

              <View>
                <Text className="text-base font-roobert-medium text-foreground mb-3">
                  Server Name
                </Text>
                <TextInput
                  value={manualServerName}
                  onChangeText={(text) => {
                    setManualServerName(text);
                    setValidationError(null);
                  }}
                  placeholder="My Custom MCP Server"
                  className="bg-muted/10 dark:bg-muted/30 rounded-xl px-4 py-3 text-base font-roobert text-foreground"
                  placeholderTextColor="rgba(156, 163, 175, 0.6)"
                />
                <Text className="text-sm font-roobert text-muted-foreground mt-2">
                  Choose a descriptive name to identify this server.
                </Text>
              </View>

              {validationError && (
                <View className="bg-destructive/10 border border-destructive/20 rounded-2xl p-4">
                  <View className="flex-row items-center gap-2">
                    <Icon as={AlertCircle} size={16} className="text-destructive" />
                    <Text className="text-sm font-roobert-medium text-destructive">
                      Configuration Error
                    </Text>
                  </View>
                  <Text className="text-sm font-roobert text-destructive/80 mt-1">
                    {validationError}
                  </Text>
                </View>
              )}

              <ActionButton
                title={isValidating ? "Discovering Tools..." : "Discover Tools"}
                description="Connect to the server and discover available tools"
                onPress={handleDiscoverTools}
                disabled={isValidating || !url.trim() || !manualServerName.trim()}
                loading={isValidating}
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

interface ActionButtonProps {
  title: string;
  description: string;
  onPress: () => void;
  disabled?: boolean;
  loading?: boolean;
}

const ActionButton = React.memo(({ 
  title, 
  description, 
  onPress, 
  disabled = false,
  loading = false
}: ActionButtonProps) => {
  const scale = useSharedValue(1);
  
  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
    opacity: disabled ? 0.5 : 1,
  }));
  
  const handlePressIn = React.useCallback(() => {
    if (!disabled) {
      scale.value = withSpring(0.98, { damping: 15, stiffness: 400 });
    }
  }, [scale, disabled]);
  
  const handlePressOut = React.useCallback(() => {
    if (!disabled) {
      scale.value = withSpring(1, { damping: 15, stiffness: 400 });
    }
  }, [scale, disabled]);
  
  return (
    <AnimatedPressable
      onPress={disabled ? undefined : onPress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      style={animatedStyle}
      className="bg-primary rounded-2xl p-4"
    >
      <View className="flex-row items-center gap-3">
        {loading ? (
          <ActivityIndicator size="small" className="text-white" />
        ) : (
          <Icon as={CheckCircle2} size={20} className="text-white" strokeWidth={2} />
        )}
        <View className="flex-1">
          <Text className="text-base font-roobert-medium text-white">
            {title}
          </Text>
          <Text className="text-sm font-roobert text-white/80">
            {description}
          </Text>
        </View>
      </View>
    </AnimatedPressable>
  );
});
