/**
 * TabsOverview — Chrome-like tab switcher with card grid.
 *
 * Shows all open session tabs as stacked cards. User can tap to switch,
 * swipe/tap X to close, or create a new tab.
 *
 * Tab cards show screenshots when available (captured by ViewShot when
 * opening the overview), falling back to text previews or icons.
 */

import React, { useCallback, useMemo, useState, useRef, useEffect } from 'react';
import {
  View,
  TouchableOpacity,
  ScrollView,
  Alert,
  Image,
  useWindowDimensions,
} from 'react-native';
import Reanimated, { useAnimatedStyle, useSharedValue, withTiming, Easing } from 'react-native-reanimated';
import { Text } from '@/components/ui/text';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { BottomSheetModal, BottomSheetBackdrop, BottomSheetView } from '@gorhom/bottom-sheet';
import type { Session } from '@/lib/opencode/types';
import { useTabStore, PAGE_TABS } from '@/stores/tab-store';
import { useTabScreenshotStore } from '@/stores/tab-screenshot-store';
import { useSyncStore } from '@/lib/opencode/sync-store';

interface TabsOverviewProps {
  sessions: Session[];
  openTabIds: string[];
  activeSessionId: string | null;
  onSelectTab: (sessionId: string) => void;
  onCloseTab: (sessionId: string) => void;
  onCloseAll: () => void;
  onNewSession: () => void;
  onDismiss: () => void;
}

export function TabsOverview({
  sessions,
  openTabIds,
  activeSessionId,
  onSelectTab,
  onCloseTab,
  onCloseAll,
  onNewSession,
  onDismiss,
}: TabsOverviewProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const insets = useSafeAreaInsets();
  const { width, height: screenHeight } = useWindowDimensions();
  const iconColor = isDark ? '#F8F8F8' : '#121215';
  const mutedColor = isDark ? '#999999' : '#6e6e6e';

  const editSheetRef = useRef<BottomSheetModal>(null);

  // Selection mode
  const [selecting, setSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Screenshots & message data for previews
  const screenshots = useTabScreenshotStore((s) => s.screenshots);
  const allMessages = useSyncStore((s) => s.messages);

  const renderBackdrop = useCallback(
    (props: any) => (
      <BottomSheetBackdrop
        {...props}
        disappearsOnIndex={-1}
        appearsOnIndex={0}
        opacity={0.4}
      />
    ),
    [],
  );

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleCloseSelected = useCallback(() => {
    if (selectedIds.size === 0) return;
    selectedIds.forEach((id) => onCloseTab(id));
    setSelectedIds(new Set());
    setSelecting(false);
  }, [selectedIds, onCloseTab]);

  const handleCloseAll = useCallback(() => {
    const total = openTabIds.length + useTabStore.getState().openPageIds.length;
    if (total === 0) return;
    Alert.alert(
      'Close All Tabs',
      `Close all ${total} tabs?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Close All',
          style: 'destructive',
          onPress: () => {
            onCloseAll();
            setSelecting(false);
            setSelectedIds(new Set());
          },
        },
      ],
    );
  }, [openTabIds, onCloseAll]);

  const exitSelecting = useCallback(() => {
    setSelecting(false);
    setSelectedIds(new Set());
  }, []);

  const getSession = useCallback(
    (id: string) => sessions.find((s) => s.id === id),
    [sessions],
  );

  // Get preview text for a session tab (fallback when no screenshot)
  const getSessionPreview = useCallback(
    (sessionId: string): string => {
      const msgs = allMessages[sessionId];
      if (!msgs || msgs.length === 0) return '';
      // Last assistant message with text
      for (let i = msgs.length - 1; i >= 0; i--) {
        const msg = msgs[i];
        if (msg.info.role === 'assistant') {
          for (let j = msg.parts.length - 1; j >= 0; j--) {
            const part = msg.parts[j];
            if (part.type === 'text' && (part as any).text) {
              return (part as any).text;
            }
          }
        }
      }
      // Last user message
      for (let i = msgs.length - 1; i >= 0; i--) {
        const msg = msgs[i];
        if (msg.info.role === 'user') {
          for (let j = msg.parts.length - 1; j >= 0; j--) {
            const part = msg.parts[j];
            if (part.type === 'text' && (part as any).text) {
              return (part as any).text;
            }
          }
        }
      }
      return '';
    },
    [allMessages],
  );

  // Combined tab list
  const openPageIds = useTabStore((s) => s.openPageIds);
  const activePageId = useTabStore((s) => s.activePageId);
  const openTabOrder = useTabStore((s) => s.openTabOrder);
  const allTabIds = useMemo(() => {
    const openSet = new Set([...openTabIds, ...openPageIds]);
    if (openSet.size === 0) return [] as string[];

    const orderedIds: string[] = [];
    const seen = new Set<string>();
    for (const id of openTabOrder) {
      if (openSet.has(id) && !seen.has(id)) {
        orderedIds.push(id);
        seen.add(id);
      }
    }

    if (seen.size === openSet.size) {
      return orderedIds;
    }

    for (const id of [...openTabIds, ...openPageIds]) {
      if (!seen.has(id)) {
        orderedIds.push(id);
        seen.add(id);
      }
    }

    return orderedIds;
  }, [openTabIds, openPageIds, openTabOrder]);
  const totalCount = allTabIds.length;

  const cardWidth = (width - 48) / 2;
  // Inner content area width (card width minus padding on each side)
  const cardContentWidth = cardWidth - 16; // 8px padding each side

  // The screenshot captures the full ViewShot (excludes bottom bar).
  // We need to crop enough from the top to hide the page header on ALL
  // pages. Headers vary in height (simple nav ~44px, Files with
  // breadcrumbs + toolbar ~100px). Use a generous crop that covers the
  // tallest header, calculated relative to safe area for device compat.
  const headerCrop = insets.top + 100;
  const screenshotFullHeight = screenHeight;

  // Card body shows the content below the cropped header.
  // Cap height so cards stay compact in the grid.
  const visibleContentHeight = screenshotFullHeight - headerCrop;
  const cardBodyHeight = Math.min(
    cardContentWidth * (visibleContentHeight / width),
    cardWidth * 1.2,
  );
  const scrollRef = useRef<ScrollView>(null);
  const hasScrolled = useRef(false);
  const activeId = activePageId || activeSessionId;

  // Entry animation — rises from the bottom to continue the peek's motion
  // when it hands off from the BottomBar swipe-up gesture.
  const entry = useSharedValue(screenHeight);
  useEffect(() => {
    entry.value = withTiming(0, {
      duration: 320,
      easing: Easing.bezier(0.22, 1, 0.36, 1),
    });
  }, [entry]);
  const entryStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: entry.value }],
  }));

  return (
    <Reanimated.View style={[{ flex: 1, paddingTop: insets.top }, entryStyle]} className="bg-background">
      {/* Header */}
      <View className="items-center px-4 py-3">
        <Text className="text-sm font-semibold text-foreground">
          {selecting
            ? `${selectedIds.size} Selected`
            : `${totalCount} ${totalCount === 1 ? 'Tab' : 'Tabs'}`}
        </Text>
      </View>

      {/* Tab cards grid */}
      <ScrollView
        ref={scrollRef}
        className="flex-1"
        contentContainerStyle={{
          flexDirection: 'row',
          flexWrap: 'wrap',
          paddingHorizontal: 12,
          paddingBottom: 20,
        }}
      >
        {totalCount === 0 ? (
          <View className="flex-1 items-center justify-center py-20" style={{ width: '100%' }}>
            <Text className="text-sm text-muted-foreground mb-4">No open tabs</Text>
            <TouchableOpacity
              onPress={onNewSession}
              className="flex-row items-center rounded-xl bg-card border border-border px-5 py-3"
              activeOpacity={0.6}
            >
              <Ionicons name="add" size={18} color={iconColor} />
              <Text className="text-sm ml-2 text-foreground">New Session</Text>
            </TouchableOpacity>
          </View>
        ) : (
          allTabIds.map((tabId) => {
            const isPage = tabId.startsWith('page:');
            const pageTab = isPage ? PAGE_TABS[tabId] : undefined;
            const session = isPage ? undefined : getSession(tabId);
            const isActive = !selecting && (
              isPage ? tabId === activePageId : tabId === activeSessionId
            );
            const isSelected = selecting && selectedIds.has(tabId);
            const tabState = isPage ? useTabStore.getState().tabStateById[tabId] : undefined;
            const title = isPage
              ? (pageTab?.label || (tabId.startsWith('page:project:') ? `Project - ${(tabState?.projectName as string) || 'Untitled'}` : tabId))
              : (session?.title || 'New Session');
            const cardIcon = isPage
              ? (pageTab?.icon || 'help-outline')
              : 'chatbubble-outline';

            const screenshotUri = screenshots[tabId];
            const previewText = !screenshotUri && !isPage
              ? getSessionPreview(tabId)
              : '';

            return (
              <TouchableOpacity
                key={tabId}
                onLayout={(e) => {
                  if (tabId === activeId && !hasScrolled.current) {
                    hasScrolled.current = true;
                    const y = e.nativeEvent.layout.y;
                    requestAnimationFrame(() => {
                      scrollRef.current?.scrollTo({ y: Math.max(0, y - 80), animated: false });
                    });
                  }
                }}
                onPress={() => {
                  if (selecting) {
                    toggleSelect(tabId);
                  } else if (isPage) {
                    useTabStore.getState().navigateToPage(tabId);
                    onDismiss();
                  } else {
                    onSelectTab(tabId);
                  }
                }}
                activeOpacity={0.7}
                style={{
                  width: cardWidth,
                  marginHorizontal: 6,
                  marginBottom: 12,
                }}
              >
                <View
                  className={`rounded-2xl overflow-hidden ${
                    isActive
                      ? 'border-2 border-primary'
                      : isSelected
                        ? 'border-2 border-primary'
                        : 'border border-border'
                  }`}
                  style={{
                    backgroundColor: isDark ? '#161618' : '#FFFFFF',
                    opacity: selecting && !isSelected ? 0.5 : 1,
                  }}
                >
                  {/* Card header */}
                  <View className="flex-row items-center justify-between px-3 pt-3 pb-1">
                    <Text
                      className="flex-1 text-xs font-medium text-foreground"
                      numberOfLines={1}
                    >
                      {title}
                    </Text>
                    {selecting ? (
                      <View className={`h-5 w-5 rounded-full items-center justify-center ml-1 ${
                        isSelected ? 'bg-primary' : 'border border-border'
                      }`}>
                        {isSelected && (
                          <Ionicons name="checkmark" size={12} color={isDark ? '#121215' : '#F8F8F8'} />
                        )}
                      </View>
                    ) : (
                      <TouchableOpacity
                        onPress={(e) => {
                          e.stopPropagation?.();
                          onCloseTab(tabId);
                        }}
                        className="ml-1 p-0.5"
                        hitSlop={8}
                        activeOpacity={0.6}
                      >
                        <Ionicons name="close" size={14} color={mutedColor} />
                      </TouchableOpacity>
                    )}
                  </View>

                  {/* Card body — screenshot, text preview, or icon fallback */}
                  <View style={{ height: cardBodyHeight, paddingHorizontal: 8, paddingBottom: 8 }}>
                    {screenshotUri ? (
                      <View className="flex-1 rounded-lg overflow-hidden" style={{ backgroundColor: isDark ? '#1a1a1e' : '#f4f4f5' }}>
                        <Image
                          source={{ uri: screenshotUri }}
                          style={{
                            width: cardContentWidth,
                            height: cardContentWidth * (screenshotFullHeight / width),
                            marginTop: -(cardContentWidth * (headerCrop / width)),
                          }}
                          resizeMode="contain"
                        />
                      </View>
                    ) : previewText ? (
                      <View
                        className="flex-1 rounded-lg overflow-hidden"
                        style={{
                          backgroundColor: isDark ? '#1a1a1e' : '#f4f4f5',
                          padding: 8,
                        }}
                      >
                        <Text
                          style={{
                            fontSize: 8,
                            lineHeight: 11,
                            color: isDark ? '#a1a1aa' : '#52525b',
                            fontFamily: 'Roobert',
                          }}
                          numberOfLines={12}
                        >
                          {previewText}
                        </Text>
                      </View>
                    ) : (
                      <View className="flex-1 rounded-lg bg-muted/30 items-center justify-center">
                        <Ionicons name={cardIcon as any} size={24} color={mutedColor} />
                      </View>
                    )}
                  </View>
                </View>
              </TouchableOpacity>
            );
          })
        )}
      </ScrollView>

      {/* Bottom toolbar */}
      <View
        className="flex-row items-center justify-between bg-card border-t border-border px-4 pt-2"
        style={{ paddingBottom: insets.bottom + 4 }}
      >
        {selecting ? (
          <View className="flex-row items-center">
            <TouchableOpacity
              onPress={handleCloseSelected}
              disabled={selectedIds.size === 0}
              activeOpacity={0.6}
              hitSlop={8}
            >
              <Text className={`text-sm ${
                selectedIds.size > 0 ? 'text-destructive' : 'text-muted-foreground/40'
              }`}>
                Close ({selectedIds.size})
              </Text>
            </TouchableOpacity>
          </View>
        ) : (
          <TouchableOpacity
            onPress={() => {
              if (totalCount > 0) editSheetRef.current?.present();
            }}
            disabled={totalCount === 0}
            activeOpacity={0.6}
            hitSlop={8}
          >
            <Text className={`text-sm ${
              totalCount > 0 ? 'text-foreground' : 'text-muted-foreground/40'
            }`}>
              Edit
            </Text>
          </TouchableOpacity>
        )}

        <TouchableOpacity
          onPress={onNewSession}
          className="items-center justify-center h-9 w-9 rounded-full bg-muted"
          activeOpacity={0.6}
        >
          <Ionicons name="add" size={24} color={iconColor} />
        </TouchableOpacity>

        <TouchableOpacity
          onPress={selecting ? exitSelecting : onDismiss}
          activeOpacity={0.6}
          hitSlop={8}
        >
          <Text className="text-sm font-medium text-foreground">
            {selecting ? 'Cancel' : 'Done'}
          </Text>
        </TouchableOpacity>
      </View>

      {/* Edit sheet */}
      <BottomSheetModal
        ref={editSheetRef}
        enableDynamicSizing
        enablePanDownToClose
        backdropComponent={renderBackdrop}
        backgroundStyle={{
          backgroundColor: isDark ? '#161618' : '#FFFFFF',
          borderTopLeftRadius: 20,
          borderTopRightRadius: 20,
        }}
        handleIndicatorStyle={{
          backgroundColor: isDark ? '#3f3f46' : '#d4d4d8',
          width: 40,
        }}
      >
        <BottomSheetView style={{ paddingBottom: insets.bottom + 12 }}>
          <TouchableOpacity
            onPress={() => {
              editSheetRef.current?.dismiss();
              setSelecting(true);
            }}
            className="flex-row items-center px-6 py-3.5"
            activeOpacity={0.6}
          >
            <Ionicons name="checkmark-circle-outline" size={20} color={iconColor} />
            <Text className="text-[15px] ml-4 text-foreground">Select Tabs</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => {
              editSheetRef.current?.dismiss();
              handleCloseAll();
            }}
            className="flex-row items-center px-6 py-3.5"
            activeOpacity={0.6}
          >
            <Ionicons name="close-circle-outline" size={20} color={isDark ? '#F87171' : '#DC2626'} />
            <Text className="text-[15px] ml-4" style={{ color: isDark ? '#F87171' : '#DC2626' }}>
              Close All Tabs
            </Text>
          </TouchableOpacity>
        </BottomSheetView>
      </BottomSheetModal>
    </Reanimated.View>
  );
}
