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
import Reanimated, { useAnimatedStyle, useSharedValue, withTiming, runOnJS, Easing } from 'react-native-reanimated';
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

  // Expansion animation: 0 = side buttons visible, 1 = collapsed (during hold).
  const expansion = useSharedValue(0);
  // Peek panel height: driven by upward swipes from the bar. Rises from 0 as
  // the user drags their finger up, previewing the tabs overview.
  const peekHeight = useSharedValue(0);
  const [isHolding, setIsHolding] = useState(false);
  const [previewId, setPreviewId] = useState<string | null>(null);

  // Layout refs — used for auto-scroll + pill-under-finger hit testing.
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

  const EASE_OUT = Easing.bezier(0.22, 1, 0.36, 1);
  const EASE_IN_OUT = Easing.bezier(0.4, 0, 0.2, 1);

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

  const endHold = useCallback((id: string | null) => {
    setIsHolding(false);
    setPreviewId(null);
    expansion.value = withTiming(0, { duration: 260, easing: EASE_IN_OUT });
    if (id && id !== activeTabId) {
      onSelectTab(id);
    }
  }, [activeTabId, onSelectTab, expansion, EASE_IN_OUT]);

  const beginHold = useCallback((fingerX: number) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    setIsHolding(true);
    expansion.value = withTiming(1, { duration: 340, easing: EASE_OUT });
    setPreviewId(pillIdAtX(fingerX));
  }, [pillIdAtX, expansion, EASE_OUT]);

  const handleDragUpdate = useCallback((dx: number, fingerX: number) => {
    scrollBy(-dx);
    setPreviewId(pillIdAtX(fingerX));
  }, [scrollBy, pillIdAtX]);

  const handleDragEnd = useCallback((fingerX: number, success: boolean) => {
    endHold(success ? pillIdAtX(fingerX) : null);
  }, [endHold, pillIdAtX]);

  // Long-press + drag: after 180ms hold, the side buttons collapse and the
  // user can drag horizontally to scrub through pills. Release selects the
  // pill under the finger. Unlike the old version this does NOT open the tabs
  // overview when releasing on the already-active pill.
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

  // Swipe-up from the bar → a peek panel rises from the bottom, growing with
  // the user's finger. Release past the threshold commits to the full tabs
  // overview; under the threshold, the peek slides back down. The bar itself
  // stays still.
  const PEEK_COMMIT = 90;
  const swipeUpGesture = useMemo(
    () => Gesture.Pan()
      .activeOffsetY(-10)
      .failOffsetX([-12, 12])
      .onUpdate((e) => {
        'worklet';
        peekHeight.value = Math.min(240, Math.max(0, -e.translationY));
      })
      .onEnd((e, success) => {
        'worklet';
        if (success && -e.translationY > PEEK_COMMIT) {
          peekHeight.value = withTiming(0, { duration: 180, easing: EASE_OUT });
          runOnJS(onOpenTabs)();
        } else {
          peekHeight.value = withTiming(0, { duration: 220 });
        }
      }),
    [peekHeight, onOpenTabs, EASE_OUT],
  );


  const sideButtonStyle = useAnimatedStyle(() => {
    const collapsed = expansion.value;
    return {
      opacity: 1 - collapsed,
      width: 40 * (1 - collapsed),
      marginHorizontal: 2 * (1 - collapsed),
      transform: [{ scale: 1 - 0.15 * collapsed }],
    };
  });

  const peekStyle = useAnimatedStyle(() => ({
    height: peekHeight.value,
    opacity: Math.min(1, peekHeight.value / 40),
  }));

  const peekContentStyle = useAnimatedStyle(() => ({
    transform: [
      { translateY: Math.max(0, 40 - peekHeight.value / 2) },
      { scale: 0.85 + Math.min(0.15, peekHeight.value / 800) },
    ],
    opacity: Math.min(1, peekHeight.value / 60),
  }));

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
      <GestureDetector gesture={swipeUpGesture}>
      <View>
      {/* Peek panel — rises above the bar as the user swipes up */}
      <Reanimated.View
        pointerEvents="none"
        style={[
          {
            backgroundColor: isDark ? '#161618' : '#FFFFFF',
            borderTopLeftRadius: 20,
            borderTopRightRadius: 20,
            borderTopWidth: 1,
            borderLeftWidth: 1,
            borderRightWidth: 1,
            borderColor: isDark ? '#2a2a2c' : '#E5E7EB',
            overflow: 'hidden',
          },
          peekStyle,
        ]}
      >
        <Reanimated.View style={[{ padding: 16, alignItems: 'center' }, peekContentStyle]}>
          <View
            style={{
              width: 40,
              height: 4,
              borderRadius: 2,
              backgroundColor: isDark ? '#3f3f46' : '#d4d4d8',
              marginBottom: 12,
            }}
          />
          <RNText
            style={{
              fontSize: 13,
              fontFamily: 'Roobert-Medium',
              color: isDark ? '#aaa' : '#666',
              letterSpacing: 0.3,
            }}
          >
            {tabs.length} {tabs.length === 1 ? 'tab' : 'tabs'} — release to open
          </RNText>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', marginTop: 14 }}>
            {tabs.slice(0, 6).map((tab) => (
              <View
                key={tab.id}
                style={{
                  width: 78,
                  height: 54,
                  borderRadius: 10,
                  margin: 4,
                  backgroundColor: isDark ? '#232324' : '#F1F1F2',
                  borderWidth: 1,
                  borderColor: isDark ? '#2a2a2c' : '#E5E7EB',
                  padding: 6,
                  justifyContent: 'flex-end',
                }}
              >
                <RNText
                  numberOfLines={2}
                  style={{
                    fontSize: 9,
                    fontFamily: 'Roobert',
                    color: isDark ? '#aaa' : '#666',
                  }}
                >
                  {tab.label}
                </RNText>
              </View>
            ))}
          </View>
        </Reanimated.View>
      </Reanimated.View>

      <View
        className="flex-row items-center bg-card border-t border-border px-2 pt-1.5"
        style={{ paddingBottom: insets.bottom + 2 }}
      >
        {/* New Session (+) — collapses when the pill strip is held */}
        <Reanimated.View style={[sideButtonStyle, { overflow: 'hidden' }]}>
          <TouchableOpacity
            onPress={onNewSession}
            className="items-center justify-center h-9 w-9 rounded-full bg-muted"
            activeOpacity={0.6}
          >
            <Ionicons name="add" size={22} color={iconColor} />
          </TouchableOpacity>
        </Reanimated.View>

        {/* Tab pills — tap to switch, long-press + drag to scrub iPhone-camera style */}
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
                      onPress={() => onSelectTab(tab.id)}
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

        {/* More (...) — collapses when the pill strip is held */}
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
      </View>
      </GestureDetector>

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
