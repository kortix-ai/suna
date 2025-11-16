import * as React from 'react';
import { View, ScrollView, Pressable, Image, ActivityIndicator, FlatList, Alert } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { 
  ArrowLeft, 
  Plug2, 
  CheckCircle2,
  Circle,
  Search,
  Save,
  AlertCircle
} from 'lucide-react-native';
import { SettingsHeader } from '../SettingsHeader';
import { useLanguage } from '@/contexts';
import { useAgent } from '@/contexts';
import { 
  useComposioTools,
  useUpdateComposioTools,
  type ComposioApp,
  type ComposioProfile,
  type ComposioTool
} from '@/hooks/useComposio';
import * as Haptics from 'expo-haptics';
import { ToolkitIcon } from './ToolkitIcon';
import Animated, { 
  useAnimatedStyle, 
  useSharedValue, 
  withSpring 
} from 'react-native-reanimated';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

interface ComposioToolsSelectorProps {
  app: ComposioApp;
  profile: ComposioProfile;
  visible: boolean;
  onClose: () => void;
  onComplete: () => void;
}

interface ComposioToolsContentProps {
  app: ComposioApp;
  profile: ComposioProfile;
  agentId: string;
  onBack?: () => void;
  onComplete: () => void;
  noPadding?: boolean;
}

export function ComposioToolsContent({
  app,
  profile,
  agentId,
  onBack,
  onComplete,
  noPadding = false
}: ComposioToolsContentProps) {
  const { t } = useLanguage();
  const { data: toolsData, isLoading, error, refetch } = useComposioTools(profile.profile_id);
  const { mutate: updateTools, isPending: isSaving } = useUpdateComposioTools();
  
  const [selectedTools, setSelectedTools] = React.useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = React.useState('');

  const tools = toolsData?.tools || [];
  
  const filteredTools = React.useMemo(() => {
    if (!searchQuery.trim()) return tools;
    
    const query = searchQuery.toLowerCase();
    return tools.filter((tool: ComposioTool) => 
      tool.name.toLowerCase().includes(query) ||
      tool.description?.toLowerCase().includes(query)
    );
  }, [tools, searchQuery]);

  const handleToolToggle = React.useCallback((toolName: string) => {
    console.log('🎯 Toggling tool:', toolName);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    
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
    console.log('🎯 Select all tools');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    
    if (selectedTools.size === tools.length) {
      setSelectedTools(new Set());
    } else {
      setSelectedTools(new Set(tools.map((tool: ComposioTool) => tool.name)));
    }
  }, [tools, selectedTools.size]);

  const handleSaveTools = React.useCallback(() => {
    if (!agentId) return;
    
    console.log('💾 Saving tools to agent:', Array.from(selectedTools));
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    updateTools({
      agentId,
      profileId: profile.profile_id,
      selectedTools: Array.from(selectedTools)
    }, {
      onSuccess: () => {
        Alert.alert('Success', `Added ${selectedTools.size} ${app.name} tools to your agent!`);
        onComplete();
      },
      onError: (error: any) => {
        Alert.alert('Error', error.message || 'Failed to save tools');
      }
    });
  }, [agentId, profile.profile_id, selectedTools, updateTools, app.name, onComplete]);

  return (
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
        
        <View className="items-center py-6">
          <ToolkitIcon 
            slug={app.slug} 
            name={app.name} 
            size="lg" 
            className="mb-4"
          />
          
          <Text className="text-xl font-roobert-semibold text-foreground text-center mb-2">
            Configure {app.name} Tools
          </Text>
          
          <Text className="text-sm font-roobert text-muted-foreground text-center">
            Select tools to add to your agent
          </Text>
        </View>

        {/* Profile Info */}
        <View className="flex-row items-center gap-3 p-4 bg-muted/5 rounded-2xl mb-6">
          <ToolkitIcon slug={app.slug} name={app.name} size="sm" />
          <View className="flex-1">
            <Text className="font-roobert-semibold text-foreground">
              {profile.profile_name}
            </Text>
            <Text className="text-sm text-muted-foreground">
              Select tools to add to your agent
            </Text>
          </View>
        </View>

        {/* Tools Count and Select All */}
        <View className="flex-row items-center justify-between mb-4">
          <Text className="text-sm text-muted-foreground">
            {selectedTools.size} of {tools.length} tools selected
          </Text>
          <Pressable
            onPress={handleSelectAll}
            className="px-4 py-2 bg-muted/10 rounded-xl active:opacity-70"
          >
            <Text className="text-sm font-roobert-medium text-primary">
              {selectedTools.size === tools.length ? 'Deselect All' : 'Select All'}
            </Text>
          </Pressable>
        </View>

        {/* Tools List - Using regular Views instead of FlatList */}
        {isLoading ? (
          <View className="items-center py-8">
            <ActivityIndicator size="large" className="text-primary" />
            <Text className="text-sm font-roobert text-muted-foreground mt-2">
              Loading tools...
            </Text>
          </View>
        ) : error ? (
          <View className="items-center py-8">
            <Icon as={AlertCircle} size={48} className="text-destructive/40" />
            <Text className="text-lg font-roobert-medium text-foreground mt-4">
              Failed to Load Tools
            </Text>
            <Text className="text-sm font-roobert text-muted-foreground text-center mt-2">
              {error.message}
            </Text>
            <Pressable
              onPress={() => refetch()}
              className="mt-4 px-4 py-2 bg-primary rounded-xl"
            >
              <Text className="text-sm font-roobert-medium text-white">
                Retry
              </Text>
            </Pressable>
          </View>
        ) : (
          <View className="space-y-3 mb-6">
            {filteredTools.length > 0 ? (
              filteredTools.map((tool: ComposioTool, index: number) => (
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
                  This integration doesn't have any tools to configure
                </Text>
              </View>
            )}
          </View>
        )}

        {/* Save Button */}
        <View className="flex-row gap-3">
          {onBack && (
            <Pressable 
              onPress={onBack}
              className="flex-1 py-4 items-center rounded-2xl border border-border/30"
            >
              <Text className="font-roobert-medium text-muted-foreground">Back</Text>
            </Pressable>
          )}
          
          <Pressable 
            onPress={handleSaveTools}
            disabled={selectedTools.size === 0 || isSaving}
            className={`flex-1 py-4 items-center rounded-2xl ${
              selectedTools.size === 0 || isSaving ? 'bg-muted/30' : 'bg-primary'
            }`}
          >
            <View className="flex-row items-center gap-2">
              {isSaving && <ActivityIndicator size="small" color="#fff" />}
              <Text className={`font-roobert-medium ${
                selectedTools.size === 0 || isSaving ? 'text-muted-foreground' : 'text-primary-foreground'
              }`}>
                {isSaving ? 'Saving...' : `Save ${selectedTools.size} Tools`}
              </Text>
            </View>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

export function ComposioToolsSelector({ 
  app, 
  profile, 
  visible, 
  onClose, 
  onComplete 
}: ComposioToolsSelectorProps) {
  const { t } = useLanguage();
  const { getCurrentAgent } = useAgent();
  const currentAgent = getCurrentAgent();
  const { data: toolsData, isLoading, error, refetch } = useComposioTools(profile.profile_id);
  const { mutate: updateTools, isPending } = useUpdateComposioTools();
  
  const [selectedTools, setSelectedTools] = React.useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = React.useState('');

  const tools = toolsData?.tools || [];

  const filteredTools = React.useMemo(() => {
    if (!searchQuery.trim()) return tools;
    
    const query = searchQuery.toLowerCase();
    return tools.filter((tool: ComposioTool) => 
      tool.name.toLowerCase().includes(query) ||
      tool.description?.toLowerCase().includes(query)
    );
  }, [tools, searchQuery]);

  React.useEffect(() => {
    if (tools.length > 0 && selectedTools.size === 0) {
      const preSelected = new Set<string>();
      tools.forEach((tool: ComposioTool) => {
        if (tool.name.includes('list') || tool.name.includes('get') || tool.name.includes('search')) {
          preSelected.add(tool.name);
        }
      });
      if (preSelected.size > 0) {
        setSelectedTools(preSelected);
      }
    }
  }, [tools, selectedTools.size]);

  const handleClose = React.useCallback(() => {
    console.log('🎯 Tools selector closing');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onClose();
  }, [onClose]);

  const handleToolToggle = React.useCallback((toolName: string) => {
    console.log('🎯 Tool toggled:', toolName);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    
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
    console.log('🎯 Select all tools');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    
    if (selectedTools.size === filteredTools.length) {
      setSelectedTools(new Set());
    } else {
      setSelectedTools(new Set(filteredTools.map((tool: ComposioTool) => tool.name)));
    }
  }, [selectedTools.size, filteredTools]);

  const handleSave = React.useCallback(() => {
    if (!currentAgent?.agent_id) {
      Alert.alert('No Agent Selected', 'Please select an agent first');
      return;
    }

    console.log('🎯 Saving tools configuration');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    
    updateTools({
      agentId: currentAgent.agent_id,
      profileId: profile.profile_id,
      selectedTools: Array.from(selectedTools),
    }, {
      onSuccess: () => {
        console.log('✅ Tools updated successfully');
        Alert.alert('Tools Added', `${selectedTools.size} tools configured for ${app.name}`);
        onComplete();
      },
      onError: (error) => {
        console.error('❌ Failed to update tools:', error);
        Alert.alert('Update Failed', error.message || 'Please try again');
      },
    });
  }, [currentAgent, profile, selectedTools, app.name, updateTools, onComplete]);

  if (!visible) return null;

  return (
    <View className="flex-1">
      <SettingsHeader
        title={`${app.name} Tools`}
        onClose={handleClose}
        variant="close"
      /> 
      <View className="flex-1">
        <View className="px-6 py-4 border-b border-border/10">
          <View className="flex-row items-center gap-3 mb-4">
            <ToolkitIcon 
              slug={app.slug} 
              name={app.name} 
              size="sm" 
            />
            <View className="flex-1">
              <Text className="text-lg font-roobert-semibold text-foreground">
                {profile.profile_name}
              </Text>
              <Text className="text-sm font-roobert text-muted-foreground">
                Select tools to add to your agent
              </Text>
            </View>
          </View>

          <View className="flex-row items-center justify-between">
            <Text className="text-sm font-roobert text-muted-foreground">
              {selectedTools.size} of {filteredTools.length} tools selected
            </Text>
            
            <Pressable
              onPress={handleSelectAll}
              className="px-3 py-1.5 rounded-lg bg-muted/10 dark:bg-muted/30"
            >
              <Text className="text-sm font-roobert-medium text-foreground">
                {selectedTools.size === filteredTools.length ? 'Deselect All' : 'Select All'}
              </Text>
            </Pressable>
          </View>
        </View>

        {isLoading ? (
          <View className="flex-1 items-center justify-center">
            <ActivityIndicator size="large" className="text-primary" />
            <Text className="text-sm font-roobert text-muted-foreground mt-4">
              Loading available tools...
            </Text>
          </View>
        ) : error ? (
          <View className="flex-1 items-center justify-center px-6">
            <Icon as={Search} size={48} className="text-muted-foreground/40" />
            <Text className="text-lg font-roobert-medium text-foreground mt-4 text-center">
              Failed to Load Tools
            </Text>
            <Text className="text-sm font-roobert text-muted-foreground text-center">
              {error.message || 'Please try again'}
            </Text>
            <Pressable
              onPress={() => refetch()}
              className="mt-4 px-4 py-2 bg-primary rounded-xl"
            >
              <Text className="text-sm font-roobert-medium text-white">
                Retry
              </Text>
            </Pressable>
          </View>
        ) : (
          <FlatList
            data={filteredTools}
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
                  This integration doesn't have any tools to configure
                </Text>
              </View>
            }
          />
        )}
      </View>
    </View>
  );
}

interface ToolCardProps {
  tool: ComposioTool;
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
        </View>
      </View>
    </AnimatedPressable>
  );
});
