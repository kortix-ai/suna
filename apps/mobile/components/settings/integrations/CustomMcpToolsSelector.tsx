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
    <View className="flex-1">
      <SettingsHeader
        title={serverName}
        onClose={handleClose}
        variant="close"
      />
      
      <View className="flex-1">
        <View className="px-6 py-4 border-b border-border/10">
          <View className="flex-row items-center gap-3 mb-4">
            <View className="h-10 w-10 rounded-xl bg-orange-100 dark:bg-orange-900/30 items-center justify-center">
              <Icon as={Globe} size={16} className="text-orange-600" />
            </View>
            <View className="flex-1">
              <Text className="text-lg font-roobert-semibold text-foreground">
                {serverName}
              </Text>
              <Text className="text-sm font-roobert text-muted-foreground">
                {displayUrl}
              </Text>
            </View>
          </View>

          <View className="flex-row items-center justify-between">
            <Text className="text-sm font-roobert text-muted-foreground">
              {selectedTools.size} of {tools.length} tools selected
            </Text>
            
            <Pressable
              onPress={handleSelectAll}
              className="px-3 py-1.5 rounded-lg bg-muted/10 dark:bg-muted/30"
            >
              <Text className="text-sm font-roobert-medium text-foreground">
                {selectedTools.size === tools.length ? 'Deselect All' : 'Select All'}
              </Text>
            </Pressable>
          </View>
        </View>

        <FlatList
          data={tools}
          keyExtractor={(item) => item.name}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingBottom: 100 }}
          renderItem={({ item }) => (
            <ToolCard
              tool={item}
              selected={selectedTools.has(item.name)}
              onToggle={() => handleToolToggle(item.name)}
            />
          )}
          ListEmptyComponent={
            <View className="flex-1 items-center justify-center py-12 px-6">
              <Icon as={Search} size={48} className="text-muted-foreground/40" />
              <Text className="text-lg font-roobert-medium text-foreground mt-4">
                No Tools Available
              </Text>
              <Text className="text-sm font-roobert text-muted-foreground text-center">
                This MCP server doesn't expose any tools
              </Text>
            </View>
          }
        />
      </View>
    </View>
  );
}

interface ToolCardProps {
  tool: any;
  selected: boolean;
  onToggle: () => void;
}

const ToolCard = React.memo(({ tool, selected, onToggle }: ToolCardProps) => {
  const scale = useSharedValue(1);
  
  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));
  
  const handlePressIn = React.useCallback(() => {
    scale.value = withSpring(0.98, { damping: 15, stiffness: 400 });
  }, [scale]);
  
  const handlePressOut = React.useCallback(() => {
    scale.value = withSpring(1, { damping: 15, stiffness: 400 });
  }, [scale]);

  const parameterCount = React.useMemo(() => {
    if (!tool.parameters?.properties) return 0;
    return Object.keys(tool.parameters.properties).length;
  }, [tool.parameters]);

  const requiredCount = React.useMemo(() => {
    if (!tool.parameters?.required) return 0;
    return tool.parameters.required.length;
  }, [tool.parameters]);
  
  return (
    <AnimatedPressable
      onPress={onToggle}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      style={animatedStyle}
      className={`mx-6 my-1.5 p-4 rounded-2xl border ${
        selected 
          ? 'bg-primary/5 border-primary/20' 
          : 'bg-muted/10 dark:bg-muted/30 border-transparent'
      }`}
    >
      <View className="flex-row items-center gap-3">
        <Icon 
          as={selected ? CheckCircle2 : Circle} 
          size={20} 
          className={selected ? 'text-primary' : 'text-muted-foreground'} 
          strokeWidth={2}
        />
        
        <View className="flex-1">
          <Text className="text-base font-roobert-medium text-foreground">
            {tool.name}
          </Text>
          
          {tool.description && (
            <Text 
              className="text-sm font-roobert text-muted-foreground mt-1" 
              numberOfLines={2}
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
      </View>
    </AnimatedPressable>
  );
});
