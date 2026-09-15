/**
 * ManageConnectionSheet — Bottom sheet for managing a connected Pipedream connection.
 * Shows icon, status, linked sandboxes, rename (via sub-sheet), and disconnect.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Pressable, Alert, ActivityIndicator, StyleSheet, Keyboard } from 'react-native';
import { Text } from '@/components/ui/text';
import { BottomSheetModal, BottomSheetView, BottomSheetTextInput } from '@gorhom/bottom-sheet';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Pencil, Trash2, Calendar, Link2, Unlink, Monitor } from 'lucide-react-native';
import { haptics } from '@/lib/haptics';

import { AppIcon } from './AppIcon';
import {
  useRenameConnection,
  useDisconnectConnection,
  useConnectionSandboxes,
  useLinkSandboxConnection,
  useUnlinkSandboxConnection,
  type ConnectorConnection,
} from '@/hooks/useConnections';
import { useSheetBottomPadding } from '@/hooks/useSheetKeyboard';
import { useSandboxContext } from '@/contexts/SandboxContext';
import { useThemeColors } from '@/lib/theme-colors';
import { THEME, withAlpha } from '@/lib/utils/theme';
import { log } from '@/lib/logger';
import { SheetBackdrop, sheetHandleIndicatorStyle, useSheetBackground } from '@/components/kortix/sheet';

interface ManageConnectionSheetProps {
  connection: ConnectorConnection | null;
  appImgSrc?: string;
  onDismiss: () => void;
}

export function ManageConnectionSheet({ connection, appImgSrc, onDismiss }: ManageConnectionSheetProps) {
  const sheetBg = useSheetBackground();
  const sheetRef = useRef<BottomSheetModal>(null);
  const renameSheetRef = useRef<BottomSheetModal>(null);
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const insets = useSafeAreaInsets();
  const sheetPadding = useSheetBottomPadding();

  const rename = useRenameConnection();
  const disconnect = useDisconnectConnection();
  const linkSandbox = useLinkSandboxConnection();
  const unlinkSandbox = useUnlinkSandboxConnection();

  const { sandboxId, sandboxUuid, sandboxName } = useSandboxContext();
  const theme = useThemeColors();

  const [renameDraft, setRenameDraft] = useState('');
  const [localLabel, setLocalLabel] = useState<string | null>(null);
  const displayName = localLabel || connection?.label || connection?.appName || connection?.app || '';

  // Fetch sandboxes linked to this connection
  const { data: sandboxData } = useConnectionSandboxes(
    connection?.connectionId ?? null,
  );

  const linkedSandboxes = sandboxData?.sandboxes ?? [];
  const isLinked = linkedSandboxes.some((s: any) => s.sandboxId === sandboxUuid);

  // Present/dismiss based on connection
  useEffect(() => {
    if (connection) {
      setRenameDraft(connection.label || connection.appName || connection.app);
      setLocalLabel(null);
      sheetRef.current?.present();
    } else {
      sheetRef.current?.dismiss();
    }
  }, [connection]);


  // ── Rename ──
  const handleOpenRename = useCallback(() => {
    if (!connection) return;
    setRenameDraft(displayName);
    haptics.medium();
    renameSheetRef.current?.present();
  }, [connection, displayName]);

  const handleConfirmRename = useCallback(async () => {
    if (!connection || !renameDraft.trim()) return;
    haptics.tap();
    Keyboard.dismiss();
    try {
      const newLabel = renameDraft.trim();
      await rename.mutateAsync({ connectionId: connection.connectionId, label: newLabel });
      setLocalLabel(newLabel);
      renameSheetRef.current?.dismiss();
      haptics.success();
    } catch (err: any) {
      haptics.warning();
      Alert.alert('Error', err?.message || 'Failed to rename');
    }
  }, [connection, renameDraft, rename]);

  // ── Link/Unlink sandbox ──
  const handleToggleLink = useCallback(async () => {
    log.log('[ManageConnection] Toggle link:', { connectionId: connection?.connectionId, sandboxUuid, sandboxId, isLinked });
    if (!connection || !sandboxUuid) return;
    haptics.selection();
    try {
      if (isLinked) {
        log.log('[ManageConnection] Unlinking...');
        await unlinkSandbox.mutateAsync({ connectionId: connection.connectionId, sandboxId: sandboxUuid });
      } else {
        log.log('[ManageConnection] Linking...');
        await linkSandbox.mutateAsync({ connectionId: connection.connectionId, sandboxId: sandboxUuid });
      }
      log.log('[ManageConnection] Success!');
      haptics.success();
    } catch (err: any) {
      haptics.warning();
      log.error('[ManageConnection] Failed:', err?.message || err);
      Alert.alert('Error', err?.message || 'Failed to update sandbox link');
    }
  }, [connection, sandboxUuid, isLinked, linkSandbox, unlinkSandbox]);

  // ── Disconnect ──
  const handleDisconnect = useCallback(() => {
    if (!connection) return;
    haptics.warning();
    Alert.alert(
      'Disconnect Connection',
      `Remove ${connection.appName || connection.app}? This will revoke access.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Disconnect',
          style: 'destructive',
          onPress: async () => {
            haptics.medium();
            try {
              await disconnect.mutateAsync(connection.connectionId);
              haptics.success();
              onDismiss();
            } catch (err: any) {
              haptics.warning();
              Alert.alert('Error', err?.message || 'Failed to disconnect');
            }
          },
        },
      ],
    );
  }, [connection, disconnect, onDismiss]);

  // ── Colors ──
  // fg/muted mirror the app-wide "old near-black-on-white / near-white-on-black"
  // literal pair — same derivation as lib/theme-colors.ts's `theme.primary`
  // (light -> THEME.light.primary, dark -> THEME.dark.foreground, NOT
  // THEME.dark.primary, which would visibly dim this text/icon in dark mode).
  const fg = theme.primary;
  const muted = withAlpha(theme.primary, 0.5);
  const subtleBg = withAlpha(theme.primary, isDark ? 0.04 : 0.02);
  const borderColor = withAlpha(theme.primary, isDark ? 0.08 : 0.06);
  const destructiveColor = isDark ? THEME.dark.destructive : THEME.light.destructive;
  const hoverBg = isDark ? THEME.dark.hover : THEME.light.hover;
  const activeBg = isDark ? THEME.dark.active : THEME.light.active;


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
      <BottomSheetModal
        ref={sheetRef}
        enableDynamicSizing
        enablePanDownToClose
        onDismiss={onDismiss}
        backdropComponent={SheetBackdrop}
        backgroundStyle={{
          backgroundColor: sheetBg,
          borderTopLeftRadius: 24,
          borderTopRightRadius: 24,
        }}
        handleIndicatorStyle={sheetHandleIndicatorStyle(isDark)}
      >
        <BottomSheetView
          style={{ padding: 20, paddingBottom: insets.bottom + 20 }}
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
                        backgroundColor:
                          connection.status === 'active'
                            ? THEME.accent.green
                            : destructiveColor,
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
                    Choose which sandboxes can use this connection for authenticated API calls.
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
                        backgroundColor: isLinked ? activeBg : theme.primary,
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
                  backgroundColor: withAlpha(destructiveColor, isDark ? 0.1 : 0.06),
                }}
              >
                {disconnect.isPending ? (
                  <ActivityIndicator size="small" color={destructiveColor} />
                ) : (
                  <Trash2 size={16} color={destructiveColor} />
                )}
                <Text style={{ fontSize: 15, fontFamily: 'Roobert-Medium', color: destructiveColor }}>
                  Disconnect
                </Text>
              </Pressable>
            </>
          )}
        </BottomSheetView>
      </BottomSheetModal>

      {/* Rename Sub-Sheet */}
      <BottomSheetModal
        ref={renameSheetRef}
        enableDynamicSizing
        enablePanDownToClose
        backdropComponent={SheetBackdrop}
        keyboardBehavior="interactive"
        keyboardBlurBehavior="restore"
        android_keyboardInputMode="adjustResize"
        onDismiss={() => setRenameDraft('')}
        backgroundStyle={{
          backgroundColor: sheetBg,
          borderTopLeftRadius: 24,
          borderTopRightRadius: 24,
        }}
        handleIndicatorStyle={sheetHandleIndicatorStyle(isDark)}
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
            placeholderTextColor={withAlpha(theme.primary, isDark ? 0.25 : 0.3)}
            autoFocus
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="done"
            onSubmitEditing={handleConfirmRename}
            style={{
              backgroundColor: hoverBg,
              borderWidth: 1,
              borderColor: activeBg,
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
              backgroundColor: !renameDraft.trim() ? hoverBg : theme.primary,
              opacity: !renameDraft.trim() ? 0.5 : 1,
            }}
          >
            {rename.isPending ? (
              <ActivityIndicator size="small" color={theme.primaryForeground} />
            ) : (
              <Text style={{ fontSize: 16, fontFamily: 'Roobert-Medium', color: theme.primaryForeground }}>
                Save
              </Text>
            )}
          </Pressable>
        </BottomSheetView>
      </BottomSheetModal>
    </>
  );
}
