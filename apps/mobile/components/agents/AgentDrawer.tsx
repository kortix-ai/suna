import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { SearchBar } from '@/components/ui/SearchBar';
import { useLanguage } from '@/contexts';
import { useAgent } from '@/contexts/AgentContext';
import BottomSheet, { BottomSheetBackdrop, BottomSheetScrollView } from '@gorhom/bottom-sheet';
import type { BottomSheetBackdropProps } from '@gorhom/bottom-sheet';
import * as Haptics from 'expo-haptics';
import { Plus } from 'lucide-react-native';
import { useColorScheme } from 'nativewind';
import * as React from 'react';
import { Pressable, View } from 'react-native';
import { AgentAvatar } from './AgentAvatar';
import { AgentList } from './AgentList';
import { useSearch } from '@/lib/utils/search';
import type { Agent } from '@/api/types';

interface AgentDrawerProps {
  visible: boolean;
  onClose: () => void;
  onCreateAgent?: () => void;
}

/**
 * AgentDrawer Component - Simplified agent selection drawer
 * 
 * Features:
 * - Search functionality
 * - My Workers section with agent list
 * - Clean agent selection interface
 * - Proper theming and haptic feedback
 * - Loading and empty states
 */
export function AgentDrawer({
  visible,
  onClose,
  onCreateAgent
}: AgentDrawerProps) {
  const bottomSheetRef = React.useRef<BottomSheet>(null);
  const snapPoints = React.useMemo(() => ['70%'], []);
  const { colorScheme } = useColorScheme();
  const { t } = useLanguage();
  
  // Get agents from context
  const { agents, selectedAgentId, selectAgent, isLoading, error, loadAgents } = useAgent();
  
  // Log drawer state for debugging
  React.useEffect(() => {
    if (visible) {
      console.log('🚪 AgentDrawer Opened:', {
        isLoading,
        error: error?.message,
        agentsCount: agents.length
      });
    }
  }, [visible, isLoading, error, agents.length]);
  
  // Search functionality - transform agents to have 'id' field for search
  const searchableAgents = React.useMemo(() => 
    agents.map(agent => ({ ...agent, id: agent.agent_id })), 
    [agents]
  );
  
  const searchFields = React.useMemo(() => ['name', 'description'], []);
  const { query, results, clearSearch, updateQuery, isSearching } = useSearch(searchableAgents, searchFields);
  
  // Transform results back to Agent type
  const agentResults = React.useMemo(() => 
    results.map(result => ({ ...result, agent_id: result.id })), 
    [results]
  );

  // Handle visibility changes
  React.useEffect(() => {
    if (visible) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      console.log('📳 Haptic Feedback: Agent Drawer Opened');
      bottomSheetRef.current?.snapToIndex(0);
    } else {
      bottomSheetRef.current?.close();
    }
  }, [visible]);

  const renderBackdrop = React.useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop
        {...props}
        disappearsOnIndex={-1}
        appearsOnIndex={0}
        opacity={0.5}
        pressBehavior="close"
      />
    ),
    []
  );

  const handleSheetChange = React.useCallback((index: number) => {
    if (index === -1) {
      onClose();
    }
  }, [onClose]);

  const handleAgentPress = React.useCallback(async (agent: Agent) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    console.log('🤖 Agent Selected:', {
      id: agent.agent_id,
      name: agent.name,
      timestamp: new Date().toISOString()
    });
    await selectAgent(agent.agent_id);
    onClose();
  }, [selectAgent, onClose]);


  return (
    <>
      <BottomSheet
        ref={bottomSheetRef}
        index={-1}
        snapPoints={snapPoints}
        enablePanDownToClose
        onChange={handleSheetChange}
        backdropComponent={renderBackdrop}
        backgroundStyle={{ 
          backgroundColor: colorScheme === 'dark' ? '#161618' : '#FFFFFF'
        }}
        handleIndicatorStyle={{ 
          backgroundColor: colorScheme === 'dark' ? '#3F3F46' : '#D4D4D8',
          width: 36,
          height: 5,
          borderRadius: 3,
          marginTop: 8,
          marginBottom: 0
        }}
        enableDynamicSizing={false}
        style={{
          borderTopLeftRadius: 24,
          borderTopRightRadius: 24,
          overflow: 'hidden'
        }}
      >
        <BottomSheetScrollView 
          className="flex-1 px-6"
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingBottom: 20 }}
        >
          {/* Header */}
          <View className="pt-6 pb-4">
            <Text className="text-foreground text-xl font-roobert-semibold">{t('agents.selectAgent')}</Text>
            <Text className="text-foreground/60 text-sm font-roobert mt-1">{t('agents.chooseAgent')}</Text>
          </View>

          {/* Search Section */}
          <View className="mb-6">
            <SearchBar
              value={query}
              onChangeText={updateQuery}
              placeholder={t('agents.searchAgents')}
              onClear={clearSearch}
            />
          </View>

          {/* My Workers Section */}
          <View className="mb-6">
            <View className="flex-row items-center justify-between mb-3">
              <Text className="text-foreground/50 text-sm font-roobert-medium">
                {t('agents.myWorkers')}
              </Text>
              {onCreateAgent && (
                <Pressable
                  onPress={() => {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                    console.log('➕ Create Agent Button Pressed');
                    onCreateAgent();
                  }}
                  className="bg-primary/15 rounded-full w-9 h-9 items-center justify-center active:opacity-70"
                >
                  <Icon as={Plus} size={16} className="text-foreground" />
                </Pressable>
              )}
            </View>

            {/* Loading State */}
            {isLoading && (
              <View className="py-8 items-center">
                <View className="w-8 h-8 bg-muted rounded-full animate-pulse mb-2" />
                <Text className="text-muted-foreground text-sm font-roobert">Loading agents...</Text>
              </View>
            )}

            {/* Error State */}
            {error && (
              <View className="py-8 items-center">
                <Text className="text-destructive text-sm font-roobert text-center mb-4">
                  Failed to load agents. Please try again.
                </Text>
                <Text className="text-muted-foreground text-xs font-roobert text-center mb-4">
                  {error.message}
                </Text>
                <Pressable
                  onPress={() => {
                    console.log('🔄 Retry loading agents');
                    loadAgents();
                  }}
                  className="bg-primary/15 rounded-lg px-4 py-2 active:opacity-70"
                >
                  <Text className="text-foreground text-sm font-roobert-medium">Retry</Text>
                </Pressable>
              </View>
            )}

            {/* Empty State */}
            {!isLoading && !error && agentResults.length === 0 && query && (
              <View className="py-8 items-center">
                <Text className="text-muted-foreground text-sm font-roobert text-center">
                  No agents found matching "{query}"
                </Text>
              </View>
            )}

            {/* Empty State - No Agents */}
            {!isLoading && !error && agentResults.length === 0 && !query && (
              <View className="py-8 items-center">
                <Text className="text-muted-foreground text-sm font-roobert text-center">
                  No agents available. Create your first agent to get started.
                </Text>
              </View>
            )}

            {/* Agent List - Using reusable AgentList component with search results */}
            {!isLoading && !error && agentResults.length > 0 && (
              <AgentList
                agents={agentResults}
                selectedAgentId={selectedAgentId}
                onAgentPress={handleAgentPress}
                showChevron={true}
                compact={true}
              />
            )}
          </View>

        </BottomSheetScrollView>
      </BottomSheet>

    </>
  );
}
