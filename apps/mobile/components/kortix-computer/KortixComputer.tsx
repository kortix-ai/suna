import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { View, Modal, Pressable } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { X } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { useKortixComputerStore } from '@/stores/kortix-computer-store';
import { ViewToggle } from './ViewToggle';
import { NavigationControls } from './NavigationControls';
import { ToolsView } from './ToolsView';
import { FileBrowserView } from './FileBrowserView';
import { FileViewerView } from './FileViewerView';
import { BrowserView } from './BrowserView';
import { extractToolCallAndResult } from '@/lib/utils/tool-data-extractor';
import type { UnifiedMessage } from '@/api/types';
import type { ToolMessagePair } from '@/components/chat';
import { log } from '@/lib/logger';

interface KortixComputerProps {
  toolMessages: ToolMessagePair[];
  currentIndex: number;
  onNavigate: (newIndex: number) => void;
  messages?: UnifiedMessage[];
  agentStatus: string;
  project?: {
    id: string;
    name: string;
    sandbox?: {
      id?: string;
      sandbox_url?: string;
      vnc_preview?: string;
      pass?: string;
    };
  };
  isLoading?: boolean;
  agentName?: string;
  onFileClick?: (filePath: string) => void;
  onPromptFill?: (prompt: string) => void;
  streamingText?: string;
  sandboxId?: string;
}

export function KortixComputer({
  toolMessages,
  currentIndex,
  onNavigate,
  messages,
  agentStatus,
  project,
  isLoading = false,
  agentName,
  onFileClick,
  onPromptFill,
  streamingText,
  sandboxId,
}: KortixComputerProps) {
  log.log('[KortixComputer] Render - toolMessages:', toolMessages.length, 'currentIndex:', currentIndex);
  
  const insets = useSafeAreaInsets();

  const {
    isOpen,
    activeView,
    filesSubView,
    selectedFilePath,
    pendingToolNavIndex,
    closePanel,
    setActiveView,
    clearPendingToolNav,
  } = useKortixComputerStore();

  const [internalIndex, setInternalIndex] = useState(currentIndex);
  const [navigationMode, setNavigationMode] = useState<'live' | 'manual'>('live');

  useEffect(() => {
    if (toolMessages.length > 0) {
      const safeIndex = Math.min(currentIndex, Math.max(0, toolMessages.length - 1));
      setInternalIndex(safeIndex);
    }
  }, [currentIndex, toolMessages.length]);

  useEffect(() => {
    if (pendingToolNavIndex !== null && pendingToolNavIndex >= 0 && pendingToolNavIndex < toolMessages.length) {
      setActiveView('tools');
      setInternalIndex(pendingToolNavIndex);
      setNavigationMode(pendingToolNavIndex === toolMessages.length - 1 ? 'live' : 'manual');
      onNavigate(pendingToolNavIndex);
      clearPendingToolNav();
    }
  }, [pendingToolNavIndex, toolMessages.length, setActiveView, onNavigate, clearPendingToolNav]);

  const safeIndex = toolMessages.length > 0 ? Math.min(internalIndex, Math.max(0, toolMessages.length - 1)) : 0;
  const currentPair = toolMessages.length > 0 && safeIndex >= 0 && safeIndex < toolMessages.length
    ? toolMessages[safeIndex]
    : undefined;
  
  log.log('[KortixComputer] currentPair:', currentPair ? 'has pair' : 'undefined');
  log.log('[KortixComputer] currentPair.toolMessage:', currentPair?.toolMessage?.message_id || 'null');
  log.log('[KortixComputer] currentPair.assistantMessage:', currentPair?.assistantMessage?.message_id || 'null');
  
  const { toolCall, toolResult, isSuccess, assistantTimestamp, toolTimestamp } = useMemo(() => {
    if (!currentPair?.toolMessage) {
      log.log('[KortixComputer] No toolMessage in currentPair, returning null');
      return { toolCall: null, toolResult: null, isSuccess: false, assistantTimestamp: undefined, toolTimestamp: undefined };
    }
    log.log('[KortixComputer] Calling extractToolCallAndResult');
    return extractToolCallAndResult(currentPair.assistantMessage, currentPair.toolMessage);
  }, [currentPair]);

  const isStreaming = toolResult === undefined;
  const totalCalls = toolMessages.length;
  const latestIndex = Math.max(0, totalCalls - 1);
  const safeInternalIndex = toolMessages.length > 0 ? Math.min(internalIndex, Math.max(0, totalCalls - 1)) : 0;

  const navigateToPrevious = useCallback(() => {
    if (safeInternalIndex > 0) {
      setNavigationMode('manual');
      const newIndex = safeInternalIndex - 1;
      setInternalIndex(newIndex);
      onNavigate(newIndex);
    }
  }, [safeInternalIndex, onNavigate]);

  const navigateToNext = useCallback(() => {
    if (safeInternalIndex < latestIndex) {
      const newIndex = safeInternalIndex + 1;
      setNavigationMode(newIndex === latestIndex ? 'live' : 'manual');
      setInternalIndex(newIndex);
      onNavigate(newIndex);
    }
  }, [safeInternalIndex, latestIndex, onNavigate]);

  const jumpToLive = useCallback(() => {
    setNavigationMode('live');
    setInternalIndex(latestIndex);
    onNavigate(latestIndex);
  }, [latestIndex, onNavigate]);

  const jumpToLatest = useCallback(() => {
    setNavigationMode('manual');
    setInternalIndex(latestIndex);
    onNavigate(latestIndex);
  }, [latestIndex, onNavigate]);

  const handleClose = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    closePanel();
  }, [closePanel]);

  const effectiveSandboxId = sandboxId || project?.sandbox?.id || '';
  const showFilesTab = !!effectiveSandboxId;

  // If files tab is hidden and we're on files view, switch to tools
  React.useEffect(() => {
    if (!showFilesTab && activeView === 'files') {
      setActiveView('tools');
    }
  }, [showFilesTab, activeView, setActiveView]);

  if (!isOpen) {
    return null;
  }

  return (
    <Modal
      visible={isOpen}
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={handleClose}
    >
      <View className="flex-1 bg-background">
        {/* Header */}
        <View
          className="px-4 py-3 border-b border-border bg-background flex-row items-center justify-between"
          style={{
            paddingTop: insets.top + 8,
          }}
        >
          <View className="flex-row items-center gap-3">
            <Text className="text-lg font-roobert-semibold text-primary">
              Kortix Computer
            </Text>
          </View>

          <View className="flex-row items-center gap-2">
            <ViewToggle
              currentView={activeView}
              onViewChange={setActiveView}
              showFilesTab={showFilesTab}
            />
            <Pressable
              onPress={handleClose}
              className="h-9 w-9 items-center justify-center rounded-xl bg-card border border-border active:opacity-70"
            >
              <Icon
                as={X}
                size={17}
                className="text-primary"
                strokeWidth={2}
              />
            </Pressable>
          </View>
        </View>

        {/* Content */}
        <View className="flex-1">
          {activeView === 'tools' && (
            <ToolsView
              toolCall={toolCall}
              toolResult={toolResult || undefined}
              assistantMessage={currentPair?.assistantMessage}
              toolMessage={currentPair?.toolMessage}
              assistantTimestamp={assistantTimestamp}
              toolTimestamp={toolTimestamp}
              isSuccess={isSuccess}
              isStreaming={isStreaming}
              project={project}
              currentIndex={safeInternalIndex}
              totalCalls={totalCalls}
              onFileClick={onFileClick}
              onPromptFill={onPromptFill}
            />
          )}

          {activeView === 'files' && (
            <>
              {filesSubView === 'viewer' && selectedFilePath ? (
                <FileViewerView
                  sandboxId={effectiveSandboxId}
                  filePath={selectedFilePath}
                  project={project}
                />
              ) : (
                <FileBrowserView
                  sandboxId={effectiveSandboxId}
                  project={project}
                />
              )}
            </>
          )}

          {activeView === 'browser' && (
            <BrowserView sandbox={project?.sandbox} />
          )}
        </View>

        {/* Navigation Controls - Only show for tools view */}
        {activeView === 'tools' && (totalCalls > 1 || (isStreaming && totalCalls > 0)) && (
          <NavigationControls
            displayIndex={safeInternalIndex}
            displayTotalCalls={totalCalls}
            safeInternalIndex={safeInternalIndex}
            latestIndex={latestIndex}
            isLiveMode={navigationMode === 'live'}
            agentStatus={agentStatus}
            onPrevious={navigateToPrevious}
            onNext={navigateToNext}
            onJumpToLive={jumpToLive}
            onJumpToLatest={jumpToLatest}
          />
        )}
      </View>
    </Modal>
  );
}

