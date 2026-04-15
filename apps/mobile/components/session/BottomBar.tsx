/**
 * BottomBar — [+] [tab pills] [...].
 *
 * The tab pill strip supports an iOS-camera-style long-press-and-drag:
 *   1. Tap a pill → switch to that tab.
 *   2. Tap the active pill → open the tabs overview.
 *   3. Long-press (180ms) on the strip → the side buttons (+ / •••) fade out,
 *      and the strip expands to fill the bar. While the user keeps their
 *      finger down they can drag left/right to scroll through tabs and
 *      preview-highlight the one under their finger. On release, the
 *      highlighted pill becomes the active tab.
 */

import React, { useCallback, useRef, useMemo, useEffect, forwardRef, useImperativeHandle, useState } from 'react';
import { View, TouchableOpacity, ScrollView, Text as RNText, type LayoutChangeEvent } from 'react-native';
import { Text } from '@/components/ui/text';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { BottomSheetModal, BottomSheetBackdrop, BottomSheetView } from '@gorhom/bottom-sheet';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Reanimated, { useAnimatedStyle, useSharedValue, withTiming, runOnJS } from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';

export type BottomBarMenuItem =
  | {
      type?: 'action';
      icon: React.ComponentType<any>;
      label: string;
      onPress: () => void;
      destructive?: boolean;
    }
  | {
      type: 'divider';
    };

export interface BottomBarTab {
  id: string;
  label: string;
  icon?: keyof typeof Ionicons.glyphMap;
}

interface BottomBarProps {
  activeSessionId: string | null;
  tabs: BottomBarTab[];
  activeTabId: string | null;
  onSelectTab: (tabId: string) => void;
  onNewSession: () => void;
  onOpenTabs: () => void;
  onCompactSession?: () => void;
  onExportTranscript?: () => void;
  onViewChanges?: () => void;
  onDiagnostics?: () => void;
  onArchiveSession?: () => void;
  customMenuItems?: BottomBarMenuItem[];
  onMenuDismiss?: () => void;
}

export interface BottomBarRef {
  presentMenu: () => void;
}

const STRIP_PADDING = 6;

export const BottomBar = forwardRef<BottomBarRef, BottomBarProps>(function BottomBar({
  activeSessionId,
  tabs,
  activeTabId,
  onSelectTab,
  onNewSession,
  onOpenTabs,
  onCompactSession,
  onExportTranscript,
  onViewChanges,
  onDiagnostics,
  onArchiveSession,
  customMenuItems,
  onMenuDismiss,
}, ref) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const insets = useSafeAreaInsets();
  const sheetRef = useRef<BottomSheetModal>(null);
  const scrollRef = useRef<ScrollView>(null);

  // Expansion animation: 0 = side buttons visible, 1 = collapsed.
  const expansion = useSharedValue(0);
  const [isHolding, setIsHolding] = useState(false);
  const [previewId, setPreviewId] = useState<string | null>(null);

  // Layout refs — pill x positions (in content coords) + widths.
  const pillLayoutsRef = useRef<Record<string, { x: number; width: number }>>({});
  const scrollOffsetRef = useRef(0);
  const viewportWidthRef = useRef(0);
  const contentWidthRef = useRef(0);

  useImperativeHandle(ref, () => ({
    presentMenu: () => sheetRef.current?.present(),
  }), []);

  const hasActiveSession = !!activeSessionId;
  const hasCustomMenu = !!customMenuItems && customMenuItems.length > 0;
  const moreEnabled = hasActiveSession || hasCustomMenu;
  const iconColor = isDark ? '#F8F8F8' : '#121215';
  const disabledColor = isDark ? '#3a3a3a' : '#c8c8c8';

  const handleMore = useCallback(() => {
    if (!moreEnabled) return;
    sheetRef.current?.present();
  }, [moreEnabled]);

  const closeSheet = useCallback(() => {
    sheetRef.current?.dismiss();
  }, []);

  const menuItems = useMemo(() => [
    { icon: 'alert-circle-outline' as const, label: 'Diagnostics', onPress: () => { closeSheet(); onDiagnostics?.(); } },
    { icon: 'git-compare-outline' as const, label: 'View changes', onPress: () => { closeSheet(); onViewChanges?.(); } },
    { icon: 'download-outline' as const, label: 'Export transcript', onPress: () => { closeSheet(); onExportTranscript?.(); } },
    { icon: 'layers-outline' as const, label: 'Compact session', onPress: () => { closeSheet(); onCompactSession?.(); } },
    { icon: 'archive-outline' as const, label: 'Archive session', onPress: () => { closeSheet(); onArchiveSession?.(); } },
  ], [closeSheet, onDiagnostics, onViewChanges, onExportTranscript, onCompactSession, onArchiveSession]);

  // Scroll the active pill into view whenever it changes.
  useEffect(() => {
    if (!activeTabId) return;
    const layout = pillLayoutsRef.current[activeTabId];
    const viewport = viewportWidthRef.current;
    if (!layout || !viewport) return;
    const target = Math.max(0, layout.x + layout.width / 2 - viewport / 2);
    scrollRef.current?.scrollTo({ x: target, animated: true });
  }, [activeTabId, tabs]);

  // Given a finger x (relative to strip viewport), return the pill id under it.
  const pillIdAtX = useCallback((fingerX: number): string | null => {
    const contentX = fingerX + scrollOffsetRef.current;
    for (const tab of tabs) {
      const layout = pillLayoutsRef.current[tab.id];
      if (!layout) continue;
      if (contentX >= layout.x && contentX <= layout.x + layout.width) {
        return tab.id;
      }
    }
    return null;
  }, [tabs]);

  // Scroll the strip by a delta, clamped to content bounds.
  const scrollBy = useCallback((delta: number) => {
    const next = Math.max(
      0,
      Math.min(
        contentWidthRef.current - viewportWidthRef.current,
        scrollOffsetRef.current + delta,
      ),
    );
    scrollOffsetRef.current = next;
    scrollRef.current?.scrollTo({ x: next, animated: false });
  }, []);

  const commitPreview = useCallback((id: string | null) => {
    setIsHolding(false);
    setPreviewId(null);
    expansion.value = withTiming(0, { duration: 180 });
    if (id && id !== activeTabId) {
      onSelectTab(id);
    } else if (id && id === activeTabId) {
      onOpenTabs();
    }
  }, [activeTabId, onOpenTabs, onSelectTab, expansion]);

  const beginHold = useCallback((fingerX: number) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    setIsHolding(true);
    expansion.value = withTiming(1, { duration: 180 });
    setPreviewId(pillIdAtX(fingerX));
  }, [pillIdAtX, expansion]);

  const handleDragUpdate = useCallback((dx: number, fingerX: number) => {
    scrollBy(-dx);
    setPreviewId(pillIdAtX(fingerX));
  }, [scrollBy, pillIdAtX]);

  const handleDragEnd = useCallback((fingerX: number, success: boolean) => {
    commitPreview(success ? pillIdAtX(fingerX) : null);
  }, [commitPreview, pillIdAtX]);

  // Long-press + drag gesture. Pan activates only after a hold so single taps
  // still propagate to the pill TouchableOpacities beneath. All JS-side logic
  // runs via a single runOnJS call per callback — the gesture callbacks are
  // worklets and cannot invoke regular JS functions directly.
  const lastTx = useSharedValue(0);
  const dragGesture = useMemo(
    () => Gesture.Pan()
      .activateAfterLongPress(180)
      .onStart((e) => {
        'worklet';
        lastTx.value = 0;
        runOnJS(beginHold)(e.x);
      })
      .onUpdate((e) => {
        'worklet';
        const dx = e.translationX - lastTx.value;
        lastTx.value = e.translationX;
        runOnJS(handleDragUpdate)(dx, e.x);
      })
      .onEnd((e, success) => {
        'worklet';
        runOnJS(handleDragEnd)(e.x, !!success);
      }),
    [beginHold, handleDragUpdate, handleDragEnd, lastTx],
  );

  const sideButtonStyle = useAnimatedStyle(() => {
    const collapsed = expansion.value;
    return {
      opacity: 1 - collapsed,
      width: 36 * (1 - collapsed),
      marginHorizontal: 2 * (1 - collapsed),
    };
  });

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

  return (
    <>
      <View
        className="flex-row items-center bg-card border-t border-border px-2 pt-1.5"
        style={{ paddingBottom: insets.bottom + 2 }}
      >
        {/* New Session (+) */}
        <Reanimated.View style={[sideButtonStyle, { overflow: 'hidden' }]}>
          <TouchableOpacity
            onPress={onNewSession}
            className="items-center justify-center h-9 w-9 rounded-full bg-muted"
            activeOpacity={0.6}
          >
            <Ionicons name="add" size={22} color={iconColor} />
          </TouchableOpacity>
        </Reanimated.View>

        {/* Tab pills — horizontally scrollable + long-press drag */}
        <GestureDetector gesture={dragGesture}>
          <View
            className="border border-border rounded-full mx-1 overflow-hidden"
            style={{ flex: 1, height: 36 }}
          >
            <ScrollView
              ref={scrollRef}
              horizontal
              showsHorizontalScrollIndicator={false}
              scrollEnabled={!isHolding}
              onLayout={(e: LayoutChangeEvent) => {
                viewportWidthRef.current = e.nativeEvent.layout.width;
              }}
              onContentSizeChange={(w) => { contentWidthRef.current = w; }}
              onScroll={(e) => {
                scrollOffsetRef.current = e.nativeEvent.contentOffset.x;
              }}
              scrollEventThrottle={16}
              contentContainerStyle={{ paddingHorizontal: STRIP_PADDING, alignItems: 'center' }}
            >
              {tabs.length === 0 ? (
                <TouchableOpacity onPress={onOpenTabs} activeOpacity={0.7} className="px-3 py-2">
                  <Text className="text-sm text-muted-foreground">No tabs</Text>
                </TouchableOpacity>
              ) : (
                tabs.map((tab) => {
                  const isActive = tab.id === activeTabId;
                  const isPreview = isHolding && previewId === tab.id;
                  const highlighted = isPreview || (!isHolding && isActive);
                  return (
                    <TouchableOpacity
                      key={tab.id}
                      onPress={() => (isActive ? onOpenTabs() : onSelectTab(tab.id))}
                      activeOpacity={0.7}
                      onLayout={(e) => {
                        pillLayoutsRef.current[tab.id] = {
                          x: e.nativeEvent.layout.x,
                          width: e.nativeEvent.layout.width,
                        };
                      }}
                      className={`items-center justify-center rounded-full px-3 py-1 mx-0.5 ${
                        highlighted ? 'bg-muted' : ''
                      }`}
                      style={{ maxWidth: 180 }}
                    >
                      <RNText
                        numberOfLines={1}
                        style={{
                          fontSize: 13,
                          fontFamily: highlighted ? 'Roobert-Medium' : 'Roobert',
                          color: highlighted ? iconColor : (isDark ? '#aaa' : '#666'),
                        }}
                      >
                        {tab.label}
                      </RNText>
                    </TouchableOpacity>
                  );
                })
              )}
            </ScrollView>
            {/* Fade edges — softer, wider gradient with smooth easing */}
            <LinearGradient
              pointerEvents="none"
              colors={
                isDark
                  ? ['rgba(22,22,24,1)', 'rgba(22,22,24,0.85)', 'rgba(22,22,24,0.5)', 'rgba(22,22,24,0.15)', 'rgba(22,22,24,0)']
                  : ['rgba(255,255,255,1)', 'rgba(255,255,255,0.85)', 'rgba(255,255,255,0.5)', 'rgba(255,255,255,0.15)', 'rgba(255,255,255,0)']
              }
              locations={[0, 0.35, 0.6, 0.85, 1]}
              start={{ x: 0, y: 0.5 }}
              end={{ x: 1, y: 0.5 }}
              style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 48 }}
            />
            <LinearGradient
              pointerEvents="none"
              colors={
                isDark
                  ? ['rgba(22,22,24,0)', 'rgba(22,22,24,0.15)', 'rgba(22,22,24,0.5)', 'rgba(22,22,24,0.85)', 'rgba(22,22,24,1)']
                  : ['rgba(255,255,255,0)', 'rgba(255,255,255,0.15)', 'rgba(255,255,255,0.5)', 'rgba(255,255,255,0.85)', 'rgba(255,255,255,1)']
              }
              locations={[0, 0.15, 0.4, 0.65, 1]}
              start={{ x: 0, y: 0.5 }}
              end={{ x: 1, y: 0.5 }}
              style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: 48 }}
            />
          </View>
        </GestureDetector>

        {/* More (...) */}
        <Reanimated.View style={[sideButtonStyle, { overflow: 'hidden' }]}>
          <TouchableOpacity
            onPress={handleMore}
            disabled={!moreEnabled}
            className="items-center justify-center h-9 w-9"
            activeOpacity={0.6}
          >
            <Ionicons
              name="ellipsis-horizontal"
              size={22}
              color={moreEnabled ? iconColor : disabledColor}
            />
          </TouchableOpacity>
        </Reanimated.View>
      </View>

      {/* More menu — bottom sheet */}
      <BottomSheetModal
        ref={sheetRef}
        enableDynamicSizing
        enablePanDownToClose
        backdropComponent={renderBackdrop}
        onDismiss={onMenuDismiss}
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
          {hasCustomMenu ? (
            customMenuItems!.map((item, index) => {
              if (item.type === 'divider') {
                return (
                  <View
                    key={`divider-${index}`}
                    className="mx-6 my-1.5"
                    style={{
                      height: 1,
                      backgroundColor: isDark
                        ? 'rgba(248, 248, 248, 0.08)'
                        : 'rgba(18, 18, 21, 0.06)',
                    }}
                  />
                );
              }
              const IconComp = item.icon;
              return (
                <TouchableOpacity
                  key={item.label}
                  onPress={() => { closeSheet(); item.onPress(); }}
                  className="flex-row items-center px-6 py-3.5"
                  activeOpacity={0.6}
                >
                  <IconComp
                    size={20}
                    color={item.destructive ? '#ef4444' : iconColor}
                    strokeWidth={1.8}
                  />
                  <Text
                    className="text-[15px] ml-4"
                    style={{ color: item.destructive ? '#ef4444' : (isDark ? '#F8F8F8' : '#121215') }}
                  >
                    {item.label}
                  </Text>
                </TouchableOpacity>
              );
            })
          ) : (
            menuItems.map((item) => (
              <TouchableOpacity
                key={item.label}
                onPress={item.onPress}
                className="flex-row items-center px-6 py-3.5"
                activeOpacity={0.6}
              >
                <Ionicons name={item.icon} size={20} color={iconColor} />
                <Text className="text-[15px] ml-4 text-foreground">{item.label}</Text>
              </TouchableOpacity>
            ))
          )}
        </BottomSheetView>
      </BottomSheetModal>
    </>
  );
});
