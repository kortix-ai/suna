import * as React from 'react';
import { View, ScrollView, Pressable, ActivityIndicator, FlatList } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { 
  ArrowLeft, 
  Globe, 
  CheckCircle2,
  Circle,
  Save,
  Search
} from 'lucide-react-native';
import { SettingsHeader } from '../SettingsHeader';
import { useLanguage } from '@/contexts';
import * as Haptics from 'expo-haptics';
import Animated, { 
  useAnimatedStyle, 
  useSharedValue, 
  withSpring 
} from 'react-native-reanimated';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

interface CustomMcpToolsContentProps {
  serverName: string;
  url: string;
  tools: any[];
  onBack?: () => void;
  onComplete: (enabledTools: string[]) => void;
  noPadding?: boolean;
}

export function CustomMcpToolsContent({
  serverName,
  url,
  tools,
  onBack,
  onComplete,
  noPadding = false
}: CustomMcpToolsContentProps) {
  const { t } = useLanguage();
  const [selectedTools, setSelectedTools] = React.useState<Set<string>>(new Set(tools.map(tool => tool.name)));
  const [isSaving, setIsSaving] = React.useState(false);

  const displayUrl = React.useMemo(() => {
    try {
      const urlObj = new URL(url);
      return urlObj.hostname;
    } catch {
      return url;
    }
  }, [url]);

  const handleToolToggle = React.useCallback((toolName: string) => {
    setSelectedTools(prev => {
      const newSet = new Set(prev);
      if (newSet.has(toolName)) {
        newSet.delete(toolName);
      } else {
        newSet.add(toolName);
      }
      return newSet;
    });
  }, []);

  const handleSelectAll = React.useCallback(() => {
    if (selectedTools.size === tools.length) {
      setSelectedTools(new Set());
    } else {
      setSelectedTools(new Set(tools.map(tool => tool.name)));
    }
  }, [selectedTools.size, tools]);

  const handleSave = React.useCallback(async () => {
    setIsSaving(true);
    try {
      await new Promise(resolve => setTimeout(resolve, 500));
      onComplete(Array.from(selectedTools));
    } catch (error) {
      console.error('❌ Failed to save custom MCP configuration:', error);
    } finally {
      setIsSaving(false);
    }
  }, [selectedTools, onComplete]);

  return (
    <View className={noPadding ? "pb-6" : "px-6 pb-6"}>
      {onBack && (
        <Pressable
          onPress={onBack}
          className="items-center justify-center w-10 h-10 mb-6 active:opacity-70 rounded-full bg-primary/10"
        >
          <ArrowLeft size={24} className="text-foreground" strokeWidth={2} />
        </Pressable>
      )}
      
      <View className="mb-8">
        <View className="flex-row items-center gap-4 mb-2">
          <View className="w-14 h-14 rounded-2xl bg-primary/5 items-center justify-center">
            <Icon as={Globe} size={24} className="text-primary" />
          </View>
          <View className="flex-1">
            <Text className="text-2xl font-roobert-bold text-foreground">
              {serverName}
            </Text>
          </View>
        </View>
        <Text className="text-base font-roobert text-muted-foreground mt-2">
          {displayUrl}
        </Text>
      </View>

      <View className="flex-row items-center justify-between mb-6">
        <Text className="text-sm font-roobert-medium text-muted-foreground uppercase tracking-wider">
          {selectedTools.size} of {tools.length} selected
        </Text>
        
        <Pressable
          onPress={handleSelectAll}
          className="px-4 py-2 rounded-full bg-muted/10 active:opacity-70"
        >
          <Text className="text-sm font-roobert-semibold text-foreground">
            {selectedTools.size === tools.length ? 'Deselect All' : 'Select All'}
          </Text>
        </Pressable>
      </View>

      <View className="space-y-3 mb-6">
        {tools.length > 0 ? (
          tools.map((tool, index) => (
            <ToolCard
              key={tool.name || index}
              tool={tool}
              selected={selectedTools.has(tool.name)}
              onToggle={() => handleToolToggle(tool.name)}
            />
          ))
        ) : (
          <View className="items-center py-12 px-6">
            <Icon as={Search} size={48} className="text-muted-foreground/40" />
            <Text className="text-lg font-roobert-medium text-foreground mt-4">
              No Tools Available
            </Text>
            <Text className="text-sm font-roobert text-muted-foreground text-center">
              This MCP server doesn't expose any tools
            </Text>
          </View>
        )}
      </View>

      <ContinueButton
        onPress={handleSave}
        disabled={selectedTools.size === 0 || isSaving}
        isLoading={isSaving}
        label={isSaving ? 'Adding Tools...' : selectedTools.size === 0 ? 'Select Tools' : selectedTools.size === 1 ? `Add ${selectedTools.size} Tool` : `Add ${selectedTools.size} Tools`}
      />
    </View>
  );
}

// Legacy component for backward compatibility
interface CustomMcpToolsSelectorProps {
  serverName: string;
  url: string;
  tools: any[];
  selectedTools: Set<string>;
  onSelectedToolsChange: (tools: Set<string>) => void;
  onClose: () => void;
  onComplete: (enabledTools: string[]) => void;
}

export function CustomMcpToolsSelector({ 
  serverName,
  url,
  tools,
  selectedTools,
  onSelectedToolsChange,
  onClose,
  onComplete
}: CustomMcpToolsSelectorProps) {
  const { t } = useLanguage();
  const [isSaving, setIsSaving] = React.useState(false);

  const handleClose = React.useCallback(() => {
    console.log('🎯 Custom MCP tools selector closing');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onClose();
  }, [onClose]);

  const handleToolToggle = React.useCallback((toolName: string) => {
    console.log('🎯 Tool toggled:', toolName);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    
    const newSelected = new Set(selectedTools);
    if (newSelected.has(toolName)) {
      newSelected.delete(toolName);
    } else {
      newSelected.add(toolName);
    }
    onSelectedToolsChange(newSelected);
  }, [selectedTools, onSelectedToolsChange]);

  const handleSelectAll = React.useCallback(() => {
    console.log('🎯 Select all tools');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    
    if (selectedTools.size === tools.length) {
      onSelectedToolsChange(new Set());
    } else {
      onSelectedToolsChange(new Set(tools.map(tool => tool.name)));
    }
  }, [selectedTools.size, tools, onSelectedToolsChange]);

  const handleSave = React.useCallback(async () => {
    console.log('🎯 Saving custom MCP tools configuration');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    
    setIsSaving(true);
    
    try {
      await new Promise(resolve => setTimeout(resolve, 500));
      onComplete(Array.from(selectedTools));
    } catch (error) {
      console.error('❌ Failed to save custom MCP configuration:', error);
    } finally {
      setIsSaving(false);
    }
  }, [selectedTools, onComplete]);

  const displayUrl = React.useMemo(() => {
    try {
      const urlObj = new URL(url);
      return urlObj.hostname;
    } catch {
      return url;
    }
  }, [url]);

  return (
    <View className="flex-1 px-6 pb-6">
      <Pressable
        onPress={handleClose}
        className="items-center justify-center w-10 h-10 mb-6 active:opacity-70 rounded-full bg-primary/10"
      >
        <ArrowLeft size={24} className="text-foreground" strokeWidth={2} />
      </Pressable>
      
      <View className="mb-8">
        <View className="flex-row items-center gap-4 mb-2">
          <View className="w-14 h-14 rounded-2xl bg-primary/5 items-center justify-center">
            <Icon as={Globe} size={24} className="text-primary" />
          </View>
          <View className="flex-1">
            <Text className="text-2xl font-roobert-bold text-foreground">
              {serverName}
            </Text>
          </View>
        </View>
        <Text className="text-base font-roobert text-muted-foreground mt-2">
          {displayUrl}
        </Text>
      </View>
      <View className="flex-row items-center justify-between mb-6">
        <Text className="text-sm font-roobert-medium text-muted-foreground uppercase tracking-wider">
          {selectedTools.size} of {tools.length} selected
        </Text>
        <Pressable
          onPress={handleSelectAll}
          className="px-4 py-2 rounded-full bg-muted/10 active:opacity-70"
        >
          <Text className="text-sm font-roobert-semibold text-foreground">
            {selectedTools.size === tools.length ? 'Deselect All' : 'Select All'}
          </Text>
        </Pressable>
      </View>
      <View className="space-y-3 mb-6">
        {tools.length > 0 ? (
          tools.map((tool, index) => (
            <ToolCard
              key={tool.name || index}
              tool={tool}
              selected={selectedTools.has(tool.name)}
              onToggle={() => handleToolToggle(tool.name)}
            />
          ))
        ) : (
          <View className="items-center py-12 px-6">
            <Icon as={Search} size={48} className="text-muted-foreground/40" />
            <Text className="text-lg font-roobert-medium text-foreground mt-4">
              No Tools Available
            </Text>
            <Text className="text-sm font-roobert text-muted-foreground text-center">
              This MCP server doesn't expose any tools
            </Text>
          </View>
        )}
      </View>

      <ContinueButton
        onPress={handleSave}
        disabled={selectedTools.size === 0 || isSaving}
        isLoading={isSaving}
        label={isSaving ? 'Adding Tools...' : selectedTools.size === 0 ? 'Select Tools' : selectedTools.size === 1 ? `Add ${selectedTools.size} Tool` : `Add ${selectedTools.size} Tools`}
        rounded="full"
      />
    </View>
  );
}

interface ToolCardProps {
  tool: any;
  selected: boolean;
  onToggle: () => void;
}

const ToolCard = React.memo(({ tool, selected, onToggle }: ToolCardProps) => {
  const parameterCount = React.useMemo(() => {
    if (!tool.parameters?.properties) return 0;
    return Object.keys(tool.parameters.properties).length;
  }, [tool.parameters]);

  const requiredCount = React.useMemo(() => {
    if (!tool.parameters?.required) return 0;
    return tool.parameters.required.length;
  }, [tool.parameters]);
  
  return (
    <Pressable
      onPress={onToggle}
      className={`flex-row items-start gap-3 p-4 rounded-3xl mb-2 active:opacity-80 ${
        selected
          ? 'bg-primary/10'
          : 'bg-muted/5'
      }`}
    >
      <View className={`w-6 h-6 rounded-full items-center justify-center mt-0.5 ${
        selected ? 'bg-primary' : 'bg-transparent border-2 border-muted-foreground/30'
      }`}>
        {selected && (
          <Icon
            as={CheckCircle2}
            size={16}
            className="text-primary-foreground"
            strokeWidth={2.5}
          />
        )}
      </View>

      <View className="flex-1">
        <Text className="font-roobert-semibold text-foreground mb-1">
          {tool.name}
        </Text>
        {tool.description && (
          <Text 
            className="text-sm font-roobert text-muted-foreground leading-relaxed"
            numberOfLines={2}
            ellipsizeMode="tail"
          >
            {tool.description}
          </Text>
        )}
        {parameterCount > 0 && (
          <View className="flex-row items-center gap-4 mt-2">
            <Text className="text-xs font-roobert text-muted-foreground">
              {parameterCount} parameter{parameterCount !== 1 ? 's' : ''}
            </Text>
            {requiredCount > 0 && (
              <Text className="text-xs font-roobert text-orange-600">
                {requiredCount} required
              </Text>
            )}
          </View>
        )}
      </View>
    </Pressable>
  );
});

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
