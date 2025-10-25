import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { SearchBar } from '@/components/ui/SearchBar';
import { useLanguage } from '@/contexts';
import { useAgent } from '@/contexts/AgentContext';
import BottomSheet, { BottomSheetScrollView, BottomSheetView } from '@gorhom/bottom-sheet';
import type { BottomSheetBackdropProps } from '@gorhom/bottom-sheet';
import * as Haptics from 'expo-haptics';
import { 
  Plus, 
  Check, 
  Briefcase, 
  FileText, 
  BookOpen, 
  Zap, 
  Layers,
  Search as SearchIcon,
  ChevronRight
} from 'lucide-react-native';
import { useColorScheme } from 'nativewind';
import * as React from 'react';
import { Pressable, View, StyleSheet } from 'react-native';
import Animated, { 
  useAnimatedStyle, 
  interpolate, 
  Extrapolate 
} from 'react-native-reanimated';
import { BlurView } from 'expo-blur';
import { AgentAvatar } from './AgentAvatar';
import { ModelAvatar } from '@/components/models/ModelAvatar';
import { SelectableListItem } from '@/components/shared/SelectableListItem';
import { EntityList } from '@/components/shared/EntityList';
import { useSearch } from '@/lib/utils/search';
import { useAvailableModels } from '@/lib/models';
import { useUpdateAgent } from '@/lib/agents';
import type { Agent, Model } from '@/api/types';

interface AgentDrawerProps {
  visible: boolean;
  onClose: () => void;
  onCreateAgent?: () => void;
}

/**
 * BlurBackdrop - Custom backdrop with blur effect
 */
function BlurBackdrop({ animatedIndex, style }: BottomSheetBackdropProps) {
  const { colorScheme } = useColorScheme();
  
  const animatedStyle = useAnimatedStyle(() => ({
    opacity: interpolate(
      animatedIndex.value,
      [-1, 0],
      [0, 1],
      Extrapolate.CLAMP
    ),
  }));

  return (
    <Animated.View style={[StyleSheet.absoluteFill, animatedStyle, style]}>
      <BlurView
        intensity={20}
        tint={colorScheme === 'dark' ? 'dark' : 'light'}
        style={StyleSheet.absoluteFill}
      />
    </Animated.View>
  );
}

/**
 * WorkerSelectionSheet - Submenu for selecting workers
 */
function WorkerSelectionSheet({
  visible,
  onClose,
  agents,
  selectedAgentId,
  onSelectAgent,
  onCreateAgent,
}: {
  visible: boolean;
  onClose: () => void;
  agents: Agent[];
  selectedAgentId?: string;
  onSelectAgent: (agent: Agent) => void;
  onCreateAgent?: () => void;
}) {
  const bottomSheetRef = React.useRef<BottomSheet>(null);
  const { colorScheme } = useColorScheme();
  const { t } = useLanguage();
  
  const searchableAgents = React.useMemo(() => 
    agents.map(agent => ({ ...agent, id: agent.agent_id })), 
    [agents]
  );
  
  const { query, results, clearSearch, updateQuery } = useSearch(searchableAgents, ['name', 'description']);
  const agentResults = React.useMemo(() => 
    results.map(result => ({ ...result, agent_id: result.id })), 
    [results]
  );

  React.useEffect(() => {
    if (visible) {
      bottomSheetRef.current?.snapToIndex(0);
    } else {
      bottomSheetRef.current?.close();
    }
  }, [visible]);

  return (
    <BottomSheet
      ref={bottomSheetRef}
      index={-1}
      snapPoints={['75%']}
      enablePanDownToClose
      onChange={(index) => index === -1 && onClose()}
      backdropComponent={BlurBackdrop}
      backgroundStyle={{ backgroundColor: 'transparent' }}
      handleIndicatorStyle={{ 
        backgroundColor: colorScheme === 'dark' ? '#3F3F46' : '#D4D4D8',
        width: 36,
        height: 5,
      }}
    >
      <BlurView
        intensity={80}
        tint={colorScheme === 'dark' ? 'dark' : 'light'}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          borderTopLeftRadius: 24,
          borderTopRightRadius: 24,
        }}
      />
      
      <View 
        style={{
          backgroundColor: colorScheme === 'dark' 
            ? 'rgba(22, 22, 24, 0.8)' 
            : 'rgba(255, 255, 255, 0.95)',
          flex: 1,
          borderTopLeftRadius: 24,
          borderTopRightRadius: 24,
        }}
      >
        <BottomSheetScrollView className="flex-1 px-6 pt-6" showsVerticalScrollIndicator={false}>
          <Text 
            style={{ color: colorScheme === 'dark' ? '#f8f8f8' : '#121215' }}
            className="text-xl font-roobert-semibold mb-1"
          >
            {t('agents.selectAgent')}
          </Text>
          <Text 
            style={{ color: colorScheme === 'dark' ? 'rgba(248, 248, 248, 0.6)' : 'rgba(18, 18, 21, 0.6)' }}
            className="text-sm font-roobert mb-4"
          >
            {t('agents.chooseAgent')}
          </Text>

          {/* Search Bar */}
          <View className="mb-4">
            <SearchBar
              value={query}
              onChangeText={updateQuery}
              placeholder={t('agents.searchAgents')}
              onClear={clearSearch}
            />
          </View>

          {/* Workers List */}
          <View className="flex-row items-center justify-between mb-3">
            <Text 
              style={{ color: colorScheme === 'dark' ? 'rgba(248, 248, 248, 0.5)' : 'rgba(18, 18, 21, 0.5)' }}
              className="text-sm font-roobert-medium"
            >
              {t('agents.myWorkers')}
            </Text>
            {onCreateAgent && (
              <Pressable
                onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  onCreateAgent();
                }}
                className="active:opacity-70"
              >
                <Plus size={18} color={colorScheme === 'dark' ? 'rgba(248, 248, 248, 0.5)' : 'rgba(18, 18, 21, 0.5)'} />
              </Pressable>
            )}
          </View>

          <EntityList
            entities={agentResults}
            isLoading={false}
            searchQuery={query}
            emptyMessage="No workers available"
            noResultsMessage="No workers found"
            gap={4}
            renderItem={(agent) => (
              <SelectableListItem
                key={agent.agent_id}
                avatar={<AgentAvatar agent={agent} size={48} />}
                title={agent.name}
                subtitle={agent.description}
                isSelected={agent.agent_id === selectedAgentId}
                onPress={() => {
                  onSelectAgent(agent);
                  onClose();
                }}
                accessibilityLabel={`Select ${agent.name} worker`}
              />
            )}
          />
        </BottomSheetScrollView>
      </View>
    </BottomSheet>
  );
}

/**
 * ModelSelectionSheet - Submenu for selecting models
 */
function ModelSelectionSheet({
  visible,
  onClose,
  models,
  selectedModelId,
  onSelectModel,
  isLoading,
}: {
  visible: boolean;
  onClose: () => void;
  models: Model[];
  selectedModelId?: string;
  onSelectModel: (model: Model) => void;
  isLoading: boolean;
}) {
  const bottomSheetRef = React.useRef<BottomSheet>(null);
  const { colorScheme } = useColorScheme();
  const { t } = useLanguage();

  React.useEffect(() => {
    if (visible) {
      bottomSheetRef.current?.snapToIndex(0);
    } else {
      bottomSheetRef.current?.close();
    }
  }, [visible]);

  return (
    <BottomSheet
      ref={bottomSheetRef}
      index={-1}
      snapPoints={['60%']}
      enablePanDownToClose
      onChange={(index) => index === -1 && onClose()}
      backdropComponent={BlurBackdrop}
      backgroundStyle={{ backgroundColor: 'transparent' }}
      handleIndicatorStyle={{ 
        backgroundColor: colorScheme === 'dark' ? '#3F3F46' : '#D4D4D8',
        width: 36,
        height: 5,
      }}
    >
      <BlurView
        intensity={80}
        tint={colorScheme === 'dark' ? 'dark' : 'light'}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          borderTopLeftRadius: 24,
          borderTopRightRadius: 24,
        }}
      />
      
      <View 
        style={{
          backgroundColor: colorScheme === 'dark' 
            ? 'rgba(22, 22, 24, 0.8)' 
            : 'rgba(255, 255, 255, 0.95)',
          flex: 1,
          borderTopLeftRadius: 24,
          borderTopRightRadius: 24,
        }}
      >
        <BottomSheetScrollView className="flex-1 px-6 pt-6" showsVerticalScrollIndicator={false}>
          <Text 
            style={{ color: colorScheme === 'dark' ? '#f8f8f8' : '#121215' }}
            className="text-xl font-roobert-semibold mb-1"
          >
            {t('models.selectModel')}
          </Text>
          <Text 
            style={{ color: colorScheme === 'dark' ? 'rgba(248, 248, 248, 0.6)' : 'rgba(18, 18, 21, 0.6)' }}
            className="text-sm font-roobert mb-6"
          >
            Choose an AI model
          </Text>

          <EntityList
            entities={models}
            isLoading={isLoading}
            loadingMessage="Loading models..."
            emptyMessage="No models available"
            gap={4}
            renderItem={(model) => (
              <SelectableListItem
                key={model.id}
                avatar={<ModelAvatar model={model} size={48} />}
                title={model.display_name}
                subtitle={model.short_name}
                isSelected={model.id === selectedModelId}
                onPress={() => {
                  onSelectModel(model);
                  onClose();
                }}
                accessibilityLabel={`Select ${model.display_name} model`}
              />
            )}
          />
        </BottomSheetScrollView>
      </View>
    </BottomSheet>
  );
}

/**
 * AgentDrawer Component - Compact agent & model selection drawer
 * 
 * Features:
 * - Blur background for modern glassmorphism effect
 * - Shows only selected worker (click to open submenu)
 * - Shows only selected model (click to open submenu)
 * - Worker Settings section with quick actions
 * - Clean, compact design that's entirely visible
 */
export function AgentDrawer({
  visible,
  onClose,
  onCreateAgent
}: AgentDrawerProps) {
  const bottomSheetRef = React.useRef<BottomSheet>(null);
  const { colorScheme } = useColorScheme();
  const { t } = useLanguage();
  
  // Get agents and models from context/API
  const { agents, selectedAgentId, selectAgent, isLoading } = useAgent();
  const { data: modelsData, isLoading: modelsLoading } = useAvailableModels();
  const updateAgentMutation = useUpdateAgent();
  
  const models = modelsData?.models || [];
  const selectedAgent = agents.find(a => a.agent_id === selectedAgentId);
  const selectedModel = models.find(m => m.id === selectedAgent?.model) || models.find(m => m.recommended);
  
  // Submenu visibility states
  const [isWorkerMenuVisible, setIsWorkerMenuVisible] = React.useState(false);
  const [isModelMenuVisible, setIsModelMenuVisible] = React.useState(false);

  // Handle visibility changes
  React.useEffect(() => {
    console.log('🎭 [AgentDrawer] Visibility changed:', visible);
    if (visible) {
      console.log('✅ [AgentDrawer] Opening drawer with haptic feedback');
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      bottomSheetRef.current?.snapToIndex(0);
    } else {
      console.log('❌ [AgentDrawer] Closing drawer');
      bottomSheetRef.current?.close();
    }
  }, [visible]);

  const handleAgentPress = React.useCallback(async (agent: Agent) => {
    console.log('🤖 Agent Selected:', agent.name);
    await selectAgent(agent.agent_id);
  }, [selectAgent]);

  const handleModelPress = React.useCallback(async (model: Model) => {
    if (!selectedAgentId) return;
    
    console.log('🎯 Model Selected:', model.display_name);
    
    try {
      await updateAgentMutation.mutateAsync({
        agentId: selectedAgentId,
        data: { model: model.id }
      });
    } catch (error) {
      console.error('Failed to update model:', error);
    }
  }, [selectedAgentId, updateAgentMutation]);

  return (
    <>
      <BottomSheet
        ref={bottomSheetRef}
        index={-1}
        enableDynamicSizing
        enablePanDownToClose
        onChange={(index) => index === -1 && onClose()}
        backdropComponent={BlurBackdrop}
        backgroundStyle={{ backgroundColor: 'transparent' }}
        handleIndicatorStyle={{ 
          backgroundColor: colorScheme === 'dark' ? '#3F3F46' : '#D4D4D8',
          width: 36,
          height: 5,
          borderRadius: 3,
          marginTop: 8,
        }}
        style={{
          borderTopLeftRadius: 24,
          borderTopRightRadius: 24,
          overflow: 'hidden'
        }}
      >
        {/* Blur Background */}
        <BlurView
          intensity={80}
          tint={colorScheme === 'dark' ? 'dark' : 'light'}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            borderTopLeftRadius: 24,
            borderTopRightRadius: 24,
          }}
        />
        
        {/* Content with semi-transparent overlay */}
        <BottomSheetView
          style={{
            backgroundColor: colorScheme === 'dark' 
              ? 'rgba(22, 22, 24, 0.8)' 
              : 'rgba(255, 255, 255, 0.95)',
            borderTopLeftRadius: 24,
            borderTopRightRadius: 24,
            paddingBottom: 32,
          }}
        >
          {/* My Workers Section - Single Selected Worker */}
          <View className="px-6 pt-6 pb-3">
            <View className="flex-row items-center justify-between mb-3">
              <Text 
                style={{ color: colorScheme === 'dark' ? 'rgba(248, 248, 248, 0.5)' : 'rgba(18, 18, 21, 0.5)' }}
                className="text-sm font-roobert-medium"
              >
                {t('agents.myWorkers')}
              </Text>
              {onCreateAgent && (
                <Pressable
                  onPress={() => {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                    onCreateAgent();
                  }}
                  className="active:opacity-70"
                >
                  <Plus size={18} color={colorScheme === 'dark' ? 'rgba(248, 248, 248, 0.5)' : 'rgba(18, 18, 21, 0.5)'} />
                </Pressable>
              )}
            </View>

            {/* Selected Worker - Clickable */}
            {selectedAgent ? (
              <SelectableListItem
                avatar={<AgentAvatar agent={selectedAgent} size={48} />}
                title={selectedAgent.name}
                subtitle={selectedAgent.description}
                showChevron
                onPress={() => setIsWorkerMenuVisible(true)}
              />
            ) : (
              <View className="py-4 items-center">
                <Text 
                  style={{ color: colorScheme === 'dark' ? 'rgba(248, 248, 248, 0.6)' : 'rgba(18, 18, 21, 0.6)' }}
                  className="text-sm font-roobert"
                >
                  {isLoading ? t('loading.threads') : 'No worker selected'}
                </Text>
              </View>
            )}
          </View>

          {/* Divider */}
          <View 
            style={{ backgroundColor: colorScheme === 'dark' ? '#232324' : '#e0e0e0' }}
            className="h-px w-full my-3" 
          />

          {/* Models Section - Single Selected Model */}
          <View className="px-6 pb-3">
            <View className="flex-row items-center justify-between mb-3">
              <Text 
                style={{ color: colorScheme === 'dark' ? 'rgba(248, 248, 248, 0.5)' : 'rgba(18, 18, 21, 0.5)' }}
                className="text-sm font-roobert-medium"
              >
                {t('models.selectModel')}
              </Text>
            </View>

            {/* Selected Model - Clickable */}
            {selectedModel ? (
              <SelectableListItem
                avatar={<ModelAvatar model={selectedModel} size={48} />}
                title={selectedModel.display_name}
                subtitle={selectedModel.short_name}
                showChevron
                onPress={() => setIsModelMenuVisible(true)}
              />
            ) : (
              <View className="py-4 items-center">
                <Text 
                  style={{ color: colorScheme === 'dark' ? 'rgba(248, 248, 248, 0.6)' : 'rgba(18, 18, 21, 0.6)' }}
                  className="text-sm font-roobert"
                >
                  {modelsLoading ? 'Loading models...' : 'No model selected'}
                </Text>
              </View>
            )}
          </View>

          {/* Divider */}
          <View 
            style={{ backgroundColor: colorScheme === 'dark' ? '#232324' : '#e0e0e0' }}
            className="h-px w-full my-3" 
          />

          {/* Worker Settings Section */}
          <View className="px-6 pb-2">
            <View className="flex-row items-center justify-between mb-2.5">
              <Text 
                style={{ color: colorScheme === 'dark' ? 'rgba(248, 248, 248, 0.5)' : 'rgba(18, 18, 21, 0.5)' }}
                className="text-sm font-roobert-medium"
              >
                Worker Settings
              </Text>
            </View>

            {/* Settings Icons Row */}
            <View className="flex-row gap-1.5 opacity-75">
              <Pressable 
                style={{ 
                  borderColor: colorScheme === 'dark' ? '#232324' : '#e0e0e0',
                  borderWidth: 1.5,
                }}
                className="flex-1 h-12 rounded-2xl items-center justify-center active:opacity-70"
                onPress={() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)}
              >
                <Briefcase size={16} color={colorScheme === 'dark' ? '#f8f8f8' : '#121215'} />
              </Pressable>
              
              <Pressable 
                style={{ 
                  borderColor: colorScheme === 'dark' ? '#232324' : '#e0e0e0',
                  borderWidth: 1.5,
                }}
                className="flex-1 h-12 rounded-2xl items-center justify-center active:opacity-70"
                onPress={() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)}
              >
                <FileText size={16} color={colorScheme === 'dark' ? '#f8f8f8' : '#121215'} />
              </Pressable>
              
              <Pressable 
                style={{ 
                  borderColor: colorScheme === 'dark' ? '#232324' : '#e0e0e0',
                  borderWidth: 1.5,
                }}
                className="flex-1 h-12 rounded-2xl items-center justify-center active:opacity-70"
                onPress={() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)}
              >
                <BookOpen size={16} color={colorScheme === 'dark' ? '#f8f8f8' : '#121215'} />
              </Pressable>
              
              <Pressable 
                style={{ 
                  borderColor: colorScheme === 'dark' ? '#232324' : '#e0e0e0',
                  borderWidth: 1.5,
                }}
                className="flex-1 h-12 rounded-2xl items-center justify-center active:opacity-70"
                onPress={() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)}
              >
                <Zap size={16} color={colorScheme === 'dark' ? '#f8f8f8' : '#121215'} />
              </Pressable>
              
              <Pressable 
                style={{ 
                  borderColor: colorScheme === 'dark' ? '#232324' : '#e0e0e0',
                  borderWidth: 1.5,
                }}
                className="flex-1 h-12 rounded-2xl items-center justify-center active:opacity-70"
                onPress={() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)}
              >
                <Layers size={16} color={colorScheme === 'dark' ? '#f8f8f8' : '#121215'} />
              </Pressable>
            </View>
          </View>
        </BottomSheetView>
      </BottomSheet>

      {/* Worker Selection Submenu */}
      <WorkerSelectionSheet
        visible={isWorkerMenuVisible}
        onClose={() => setIsWorkerMenuVisible(false)}
        agents={agents}
        selectedAgentId={selectedAgentId}
        onSelectAgent={handleAgentPress}
        onCreateAgent={onCreateAgent}
      />

      {/* Model Selection Submenu */}
      <ModelSelectionSheet
        visible={isModelMenuVisible}
        onClose={() => setIsModelMenuVisible(false)}
        models={models}
        selectedModelId={selectedModel?.id}
        onSelectModel={handleModelPress}
        isLoading={modelsLoading}
      />
    </>
  );
}
