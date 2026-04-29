/**
 * ManageConnectionSheet — Bottom sheet for managing a connected Pipedream integration.
 * Shows icon, status, linked sandboxes, rename (via sub-sheet), and disconnect.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Pressable, Alert, ActivityIndicator, StyleSheet, Keyboard } from 'react-native';
import { Text } from '@/components/ui/text';
import BottomSheet, { BottomSheetBackdrop, BottomSheetScrollView, BottomSheetModal, BottomSheetView, BottomSheetTextInput } from '@gorhom/bottom-sheet';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Pencil, Trash2, Calendar, Link2, Unlink, Monitor } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';

import { AppIcon } from './AppIcon';
import {
  useRenameIntegration,
  useDisconnectIntegration,
  useIntegrationSandboxes,
  useLinkSandboxIntegration,
  useUnlinkSandboxIntegration,
  type IntegrationConnection,
} from '@/hooks/useIntegrations';
import { useSheetBottomPadding } from '@/hooks/useSheetKeyboard';
import { useSandboxContext } from '@/contexts/SandboxContext';
import { useThemeColors, getSheetBg } from '@/lib/theme-colors';
import { log } from '@/lib/logger';

interface ManageConnectionSheetProps {
  connection: IntegrationConnection | null;
  appImgSrc?: string;
  onDismiss: () => void;
}

export function ManageConnectionSheet({ connection, appImgSrc, onDismiss }: ManageConnectionSheetProps) {
  const sheetRef = useRef<BottomSheet>(null);
  const renameSheetRef = useRef<BottomSheetModal>(null);
  const snapPoints = useMemo(() => ['60%', '85%'], []);
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const insets = useSafeAreaInsets();
  const sheetPadding = useSheetBottomPadding();

  const rename = useRenameIntegration();
  const disconnect = useDisconnectIntegration();
  const linkSandbox = useLinkSandboxIntegration();
  const unlinkSandbox = useUnlinkSandboxIntegration();

  const { sandboxId, sandboxUuid, sandboxName } = useSandboxContext();
  const theme = useThemeColors();

  const [renameDraft, setRenameDraft] = useState('');
  const [localLabel, setLocalLabel] = useState<string | null>(null);

  // Fetch sandboxes linked to this integration
  const { data: sandboxData } = useIntegrationSandboxes(
    connection?.integrationId ?? null,
  );

  const linkedSandboxes = sandboxData?.sandboxes ?? [];
  const isLinked = linkedSandboxes.some((s: any) => s.sandboxId === sandboxUuid);

  // Present/dismiss based on connection
  useEffect(() => {
    if (connection) {
      setRenameDraft(connection.label || connection.appName || connection.app);
      setLocalLabel(null);
      sheetRef.current?.snapToIndex(0);
    } else {
      sheetRef.current?.close();
    }
  }, [connection]);

  const handleSheetChange = useCallback(
    (index: number) => {
      if (index === -1) onDismiss();
    },
    [onDismiss],
  );

  const renderBackdrop = useCallback(
    (props: any) => (
      <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} opacity={0.5} />
    ),
    [],
  );

  // ── Rename ──
  const handleOpenRename = useCallback(() => {
    if (!connection) return;
    setRenameDraft(displayName);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    renameSheetRef.current?.present();
  }, [connection, displayName]);

  const handleConfirmRename = useCallback(async () => {
    if (!connection || !renameDraft.trim()) return;
    Keyboard.dismiss();
    try {
      const newLabel = renameDraft.trim();
      await rename.mutateAsync({ integrationId: connection.integrationId, label: newLabel });
      setLocalLabel(newLabel);
      renameSheetRef.current?.dismiss();
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'Failed to rename');
    }
  }, [connection, renameDraft, rename]);

  // ── Link/Unlink sandbox ──
  const handleToggleLink = useCallback(async () => {
    log.log('[ManageConnection] Toggle link:', { integrationId: connection?.integrationId, sandboxUuid, sandboxId, isLinked });
    if (!connection || !sandboxUuid) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    try {
      if (isLinked) {
        log.log('[ManageConnection] Unlinking...');
        await unlinkSandbox.mutateAsync({ integrationId: connection.integrationId, sandboxId: sandboxUuid });
      } else {
        log.log('[ManageConnection] Linking...');
        await linkSandbox.mutateAsync({ integrationId: connection.integrationId, sandboxId: sandboxUuid });
      }
      log.log('[ManageConnection] Success!');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err: any) {
      log.error('[ManageConnection] Failed:', err?.message || err);
      Alert.alert('Error', err?.message || 'Failed to update sandbox link');
    }
  }, [connection, sandboxUuid, isLinked, linkSandbox, unlinkSandbox]);

  // ── Disconnect ──
  const handleDisconnect = useCallback(() => {
    if (!connection) return;
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    Alert.alert(
      'Disconnect Integration',
      `Remove ${connection.appName || connection.app}? This will revoke access.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Disconnect',
          style: 'destructive',
          onPress: async () => {
            try {
              await disconnect.mutateAsync(connection.integrationId);
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              onDismiss();
            } catch (err: any) {
              Alert.alert('Error', err?.message || 'Failed to disconnect');
            }
          },
        },
      ],
    );
  }, [connection, disconnect, onDismiss]);

  // ── Colors ──
  const fg = isDark ? '#f8f8f8' : '#121215';
  const muted = isDark ? 'rgba(248,248,248,0.5)' : 'rgba(18,18,21,0.5)';
  const subtleBg = isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.02)';
  const borderColor = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)';

  const displayName = localLabel || connection?.label || connection?.appName || connection?.app || '';

  const formatDate = (iso: string | null) => {
    if (!iso) return null;
    try {
      return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    } catch {
      return null;
    }
  };

  return (
    <>
      <BottomSheet
        ref={sheetRef}
        index={-1}
        snapPoints={snapPoints}
        enablePanDownToClose
        onChange={handleSheetChange}
        backdropComponent={renderBackdrop}
        backgroundStyle={{ backgroundColor: getSheetBg(isDark) }}
        handleIndicatorStyle={{ backgroundColor: isDark ? '#555' : '#ccc' }}
      >
        <BottomSheetScrollView
          contentContainerStyle={{ padding: 20, paddingBottom: insets.bottom + 20 }}
        >
          {connection && (
            <>
              {/* Header — Icon left, Name + Provider right */}
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14, marginBottom: 20 }}>
                <AppIcon
                  name={connection.appName || connection.app}
                  imgSrc={appImgSrc || (connection.metadata as any)?.imgSrc}
                  size={48}
                />
                <View style={{ flex: 1 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <Text style={{ fontSize: 18, fontFamily: 'Roobert-Medium', color: fg }}>
                      {displayName}
                    </Text>
                    <Pressable onPress={handleOpenRename} hitSlop={8}>
                      <Pencil size={14} color={muted} />
                    </Pressable>
                  </View>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 3 }}>
                    <View
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: 3,
                        backgroundColor: connection.status === 'active' ? '#34d399' : '#ef4444',
                      }}
                    />
                    <Text style={{ fontSize: 13, fontFamily: 'Roobert', color: muted }}>
                      {connection.appName || connection.app}
                    </Text>
                  </View>
                </View>
              </View>

              {/* Connected date */}
              {connection.connectedAt && (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 20 }}>
                  <Calendar size={16} color={muted} />
                  <Text style={{ fontSize: 14, fontFamily: 'Roobert', color: muted }}>
                    Connected {formatDate(connection.connectedAt)}
                  </Text>
                </View>
              )}

              {/* Linked Sandboxes */}
              {sandboxUuid && (
                <View style={{ marginBottom: 24 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                    <Link2 size={16} color={muted} />
                    <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: muted, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                      Linked Sandboxes
                    </Text>
                  </View>
                  <Text style={{ fontSize: 13, fontFamily: 'Roobert', color: muted, marginBottom: 12 }}>
                    Choose which sandboxes can use this integration for authenticated API calls.
                  </Text>

                  {/* Current sandbox row */}
                  <View
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      paddingVertical: 12,
                      paddingHorizontal: 14,
                      borderRadius: 12,
                      backgroundColor: subtleBg,
                      borderWidth: StyleSheet.hairlineWidth,
                      borderColor,
                    }}
                  >
                    <Monitor size={18} color={muted} style={{ marginRight: 10 }} />
                    <Text style={{ flex: 1, fontSize: 14, fontFamily: 'Roobert', color: fg }} numberOfLines={1}>
                      {sandboxName || sandboxId}
                    </Text>
                    <Pressable
                      onPress={handleToggleLink}
                      disabled={linkSandbox.isPending || unlinkSandbox.isPending}
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 6,
                        paddingHorizontal: 14,
                        paddingVertical: 6,
                        borderRadius: 9999,
                        backgroundColor: isLinked
                          ? (isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)')
                          : theme.primary,
                      }}
                    >
                      {(linkSandbox.isPending || unlinkSandbox.isPending) ? (
                        <ActivityIndicator size="small" color={isLinked ? muted : theme.primaryForeground} />
                      ) : isLinked ? (
                        <>
                          <Unlink size={13} color={muted} />
                          <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: muted }}>Unlink</Text>
                        </>
                      ) : (
                        <>
                          <Link2 size={13} color={theme.primaryForeground} />
                          <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: theme.primaryForeground }}>Link</Text>
                        </>
                      )}
                    </Pressable>
                  </View>
                </View>
              )}

              {/* Disconnect */}
              <Pressable
                onPress={handleDisconnect}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 8,
                  paddingVertical: 14,
                  borderRadius: 9999,
                  backgroundColor: isDark ? 'rgba(239,68,68,0.1)' : 'rgba(239,68,68,0.06)',
                }}
              >
                {disconnect.isPending ? (
                  <ActivityIndicator size="small" color="#ef4444" />
                ) : (
                  <Trash2 size={16} color="#ef4444" />
                )}
                <Text style={{ fontSize: 15, fontFamily: 'Roobert-Medium', color: '#ef4444' }}>
                  Disconnect
                </Text>
              </Pressable>
            </>
          )}
        </BottomSheetScrollView>
      </BottomSheet>

      {/* Rename Sub-Sheet */}
      <BottomSheetModal
        ref={renameSheetRef}
        enableDynamicSizing
        enablePanDownToClose
        backdropComponent={renderBackdrop}
        keyboardBehavior="interactive"
        keyboardBlurBehavior="restore"
        android_keyboardInputMode="adjustResize"
        onDismiss={() => setRenameDraft('')}
        backgroundStyle={{
          backgroundColor: getSheetBg(isDark),
          borderTopLeftRadius: 24,
          borderTopRightRadius: 24,
        }}
        handleIndicatorStyle={{
          backgroundColor: isDark ? '#3F3F46' : '#D4D4D8',
          width: 36,
          height: 5,
          borderRadius: 3,
        }}
      >
        <BottomSheetView
          style={{
            paddingHorizontal: 24,
            paddingTop: 8,
            paddingBottom: sheetPadding,
          }}
        >
          {/* Header */}
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 20 }}>
            {connection && (
              <View style={{ marginRight: 12 }}>
                <AppIcon
                  name={connection.appName || connection.app}
                  imgSrc={appImgSrc || (connection.metadata as any)?.imgSrc}
                  size={40}
                />
              </View>
            )}
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 18, fontFamily: 'Roobert-Semibold', color: fg }}>
                Rename
              </Text>
              <Text style={{ fontSize: 12, fontFamily: 'Roobert', color: muted, marginTop: 2 }} numberOfLines={1}>
                {displayName}
              </Text>
            </View>
          </View>

          {/* Input */}
          <BottomSheetTextInput
            value={renameDraft}
            onChangeText={setRenameDraft}
            placeholder="Enter new name"
            placeholderTextColor={isDark ? 'rgba(248,248,248,0.25)' : 'rgba(18,18,21,0.3)'}
            autoFocus
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="done"
            onSubmitEditing={handleConfirmRename}
            style={{
              backgroundColor: isDark ? 'rgba(248,248,248,0.06)' : 'rgba(18,18,21,0.04)',
              borderWidth: 1,
              borderColor: isDark ? 'rgba(248,248,248,0.1)' : 'rgba(18,18,21,0.08)',
              borderRadius: 14,
              paddingHorizontal: 16,
              paddingVertical: 14,
              fontSize: 16,
              fontFamily: 'Roobert',
              color: fg,
              marginBottom: 20,
            }}
          />

          {/* Save button */}
          <Pressable
            onPress={handleConfirmRename}
            disabled={!renameDraft.trim() || rename.isPending}
            style={{
              alignItems: 'center',
              justifyContent: 'center',
              paddingVertical: 14,
              borderRadius: 9999,
              backgroundColor: !renameDraft.trim() ? (isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)') : fg,
              opacity: !renameDraft.trim() ? 0.5 : 1,
            }}
          >
            {rename.isPending ? (
              <ActivityIndicator size="small" color={isDark ? '#121215' : '#F8F8F8'} />
            ) : (
              <Text style={{ fontSize: 16, fontFamily: 'Roobert-Medium', color: isDark ? '#121215' : '#F8F8F8' }}>
                Save
              </Text>
            )}
          </Pressable>
        </BottomSheetView>
      </BottomSheetModal>
    </>
  );
}
