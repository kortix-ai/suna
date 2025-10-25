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
  ChevronRight,
  ArrowLeft
} from 'lucide-react-native';
import { useColorScheme } from 'nativewind';
import * as React from 'react';
import { Pressable, View, StyleSheet, ScrollView } from 'react-native';
import Animated, { 
  useAnimatedStyle, 
  interpolate, 
  Extrapolate,
  withTiming,
  useSharedValue,
  FadeIn,
  FadeOut
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

type ViewState = 'main' | 'agents' | 'models';

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
 * BackButton - Reusable back button component
 */
function BackButton({ onPress }: { onPress: () => void }) {
  const { colorScheme } = useColorScheme();
  
  return (
    <Pressable
      onPress={onPress}
      className="flex-row items-center active:opacity-70"
    >
      <ArrowLeft 
        size={20} 
        color={colorScheme === 'dark' ? '#f8f8f8' : '#121215'} 
      />
    </Pressable>
  );
}

/**
 * AgentDrawer Component - Dynamic agent & model selection drawer
 * 
 * Features:
 * - Blur background for modern glassmorphism effect
 * - Dynamic content switching between main, agents, and models views
 * - Smooth transitions with fade animations
 * - Back button navigation
 * - Full height utilization for all views
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
  
  // Dynamic view state management
  const [currentView, setCurrentView] = React.useState<ViewState>('main');
  
  // Search functionality for agents
  const searchableAgents = React.useMemo(() => 
    agents.map(agent => ({ ...agent, id: agent.agent_id })), 
    [agents]
  );
  const { query: agentQuery, results: agentResults, clearSearch: clearAgentSearch, updateQuery: updateAgentQuery } = useSearch(searchableAgents, ['name', 'description']);
  const processedAgentResults = React.useMemo(() => 
    agentResults.map(result => ({ ...result, agent_id: result.id })), 
    [agentResults]
  );

  // Handle visibility changes
  React.useEffect(() => {
    console.log('🎭 [AgentDrawer] Visibility changed:', visible);
    if (visible) {
      console.log('✅ [AgentDrawer] Opening drawer with haptic feedback');
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      bottomSheetRef.current?.snapToIndex(0);
      setCurrentView('main'); // Reset to main view when opening
    } else {
      console.log('❌ [AgentDrawer] Closing drawer');
      bottomSheetRef.current?.close();
    }
  }, [visible]);

  // Navigation functions
  const navigateToView = React.useCallback((view: ViewState) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setCurrentView(view);
  }, []);

  const handleAgentPress = React.useCallback(async (agent: Agent) => {
    console.log('🤖 Agent Selected:', agent.name);
    await selectAgent(agent.agent_id);
    navigateToView('main');
  }, [selectAgent, navigateToView]);

  const handleModelPress = React.useCallback(async (model: Model) => {
    if (!selectedAgentId) return;
    
    console.log('🎯 Model Selected:', model.display_name);
    
    try {
      await updateAgentMutation.mutateAsync({
        agentId: selectedAgentId,
        data: { model: model.id }
      });
      navigateToView('main');
    } catch (error) {
      console.error('Failed to update model:', error);
    }
  }, [selectedAgentId, updateAgentMutation, navigateToView]);

  // Render main view content
  const renderMainView = () => (
    <ScrollView showsVerticalScrollIndicator={false}>
      {/* My Workers Section */}
      <View className="pb-3">
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
            onPress={() => navigateToView('agents')}
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

      {/* Models Section */}
      <View className="pb-3">
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
            onPress={() => navigateToView('models')}
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
      <View className="pb-2">
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
    </ScrollView>
  );

  // Render agents view content
  const renderAgentsView = () => (
    <ScrollView showsVerticalScrollIndicator={false}>
      {/* Header with back button */}
      <View className="flex-row items-center mb-4">
        <BackButton onPress={() => navigateToView('main')} />
        <View className="flex-1 ml-3">
          <Text 
            style={{ color: colorScheme === 'dark' ? '#f8f8f8' : '#121215' }}
            className="text-xl font-roobert-semibold"
          >
            {t('agents.selectAgent')}
          </Text>
          <Text 
            style={{ color: colorScheme === 'dark' ? 'rgba(248, 248, 248, 0.6)' : 'rgba(18, 18, 21, 0.6)' }}
            className="text-sm font-roobert"
          >
            {t('agents.chooseAgent')}
          </Text>
        </View>
      </View>

      {/* Search Bar */}
      <View className="mb-4">
        <SearchBar
          value={agentQuery}
          onChangeText={updateAgentQuery}
          placeholder={t('agents.searchAgents')}
          onClear={clearAgentSearch}
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
        entities={processedAgentResults}
        isLoading={false}
        searchQuery={agentQuery}
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
            onPress={() => handleAgentPress(agent)}
            accessibilityLabel={`Select ${agent.name} worker`}
          />
        )}
      />
    </ScrollView>
  );

  // Render models view content
  const renderModelsView = () => (
    <ScrollView showsVerticalScrollIndicator={false}>
      {/* Header with back button */}
      <View className="flex-row items-center mb-6">
        <BackButton onPress={() => navigateToView('main')} />
        <View className="flex-1 ml-3">
          <Text 
            style={{ color: colorScheme === 'dark' ? '#f8f8f8' : '#121215' }}
            className="text-xl font-roobert-semibold"
          >
            {t('models.selectModel')}
          </Text>
          <Text 
            style={{ color: colorScheme === 'dark' ? 'rgba(248, 248, 248, 0.6)' : 'rgba(18, 18, 21, 0.6)' }}
            className="text-sm font-roobert"
          >
            Choose an AI model
          </Text>
        </View>
      </View>

      <EntityList
        entities={models}
        isLoading={modelsLoading}
        loadingMessage="Loading models..."
        emptyMessage="No models available"
        gap={4}
        renderItem={(model) => (
          <SelectableListItem
            key={model.id}
            avatar={<ModelAvatar model={model} size={48} />}
            title={model.display_name}
            subtitle={model.short_name}
            isSelected={model.id === selectedModel?.id}
            onPress={() => handleModelPress(model)}
            accessibilityLabel={`Select ${model.display_name} model`}
          />
        )}
      />
    </ScrollView>
  );

  return (
    <BottomSheet
      ref={bottomSheetRef}
      index={-1}
      enableDynamicSizing
      enablePanDownToClose
      onChange={(index) => index === -1 && onClose()}
      backdropComponent={BlurBackdrop}
      backgroundStyle={{ 
        backgroundColor: colorScheme === 'dark' 
          ? 'rgba(22, 22, 24, 0.8)' 
          : 'rgba(255, 255, 255, 0.95)',
        borderTopLeftRadius: 24,
        borderTopRightRadius: 24,
      }}
      handleIndicatorStyle={{ 
        backgroundColor: colorScheme === 'dark' ? '#3F3F46' : '#D4D4D8',
        width: 36,
        height: 5,
        borderRadius: 3,
      }}
    >
      {/* Content with proper height management */}
      <BottomSheetView
        style={{
          paddingHorizontal: 24,
          paddingTop: 24,
          paddingBottom: 32,
        }}
      >
        {/* Dynamic content based on current view */}
        {currentView === 'main' && (
          <Animated.View entering={FadeIn.duration(300)} exiting={FadeOut.duration(200)}>
            {renderMainView()}
          </Animated.View>
        )}
        
        {currentView === 'agents' && (
          <Animated.View entering={FadeIn.duration(300)} exiting={FadeOut.duration(200)}>
            {renderAgentsView()}
          </Animated.View>
        )}
        
        {currentView === 'models' && (
          <Animated.View entering={FadeIn.duration(300)} exiting={FadeOut.duration(200)}>
            {renderModelsView()}
          </Animated.View>
        )}
      </BottomSheetView>
    </BottomSheet>
  );
}