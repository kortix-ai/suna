import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { SearchBar } from '@/components/ui/SearchBar';
import { useLanguage } from '@/contexts';
import BottomSheet, { BottomSheetBackdrop, BottomSheetScrollView } from '@gorhom/bottom-sheet';
import type { BottomSheetBackdropProps } from '@gorhom/bottom-sheet';
import * as Haptics from 'expo-haptics';
import { Plus } from 'lucide-react-native';
import { useColorScheme } from 'nativewind';
import * as React from 'react';
import { Pressable, View } from 'react-native';
import { AgentAvatar } from './AgentAvatar';
import { AgentList } from './AgentList';
import { useSearch } from '@/lib/search';
import type { Agent } from '../shared/types';

interface AgentDrawerProps {
  visible: boolean;
  onClose: () => void;
  agents: Agent[];
  selectedAgentId: string;
  onSelectAgent: (agent: Agent) => void;
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
 */
export function AgentDrawer({
  visible,
  onClose,
  agents,
  selectedAgentId,
  onSelectAgent,
  onCreateAgent
}: AgentDrawerProps) {
  const bottomSheetRef = React.useRef<BottomSheet>(null);
  const snapPoints = React.useMemo(() => ['70%'], []);
  const { colorScheme } = useColorScheme();
  const { t } = useLanguage();
  
  // Search functionality
  const searchFields = React.useMemo(() => ['name', 'description'], []);
  const { query, results, clearSearch, updateQuery, isSearching } = useSearch(agents, searchFields);

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

  const handleAgentPress = React.useCallback((agent: Agent) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    console.log('🤖 Agent Selected:', {
      id: agent.id,
      name: agent.name,
      timestamp: new Date().toISOString()
    });
    onSelectAgent(agent);
    onClose();
  }, [onSelectAgent, onClose]);


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

            {/* Agent List - Using reusable AgentList component with search results */}
            <AgentList
              agents={results}
              selectedAgentId={selectedAgentId}
              onAgentPress={handleAgentPress}
              showChevron={true}
              compact={true}
            />
          </View>

        </BottomSheetScrollView>
      </BottomSheet>

    </>
  );
}
