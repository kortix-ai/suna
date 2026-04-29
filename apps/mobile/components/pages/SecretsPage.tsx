/**
 * SecretsPage — Environment variables / secrets manager for the mobile app.
 *
 * Uses the OpenCode env API (GET/PUT/DELETE {sandboxUrl}/env) to list,
 * create, update, and delete secrets — matching the web frontend.
 * All mutations happen through bottom sheets following the FilesPage pattern.
 */

import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import {
  View,
  TouchableOpacity,
  ScrollView,
  Alert,
  RefreshControl,
  ActivityIndicator,
  Platform,
  TextInput,
  Pressable,
} from 'react-native';
import { Text } from '@/components/ui/text';
import {
  Plus,
  Trash2,
  Pencil,
  Eye,
  EyeOff,
  Key,
  AlertTriangle,
  Search,
  X,
} from 'lucide-react-native';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import {
  BottomSheetModal,
  BottomSheetBackdrop,
  BottomSheetView,
  BottomSheetTextInput,
  TouchableOpacity as BottomSheetTouchable,
} from '@gorhom/bottom-sheet';
import type { BottomSheetBackdropProps } from '@gorhom/bottom-sheet';

import { useSheetBottomPadding } from '@/hooks/useSheetKeyboard';
import { useSandboxContext } from '@/contexts/SandboxContext';
import { getAuthToken } from '@/api/config';
import { log } from '@/lib/logger';
import type { PageTab } from '@/stores/tab-store';
import { PageHeader } from '@/components/ui/page-header';
import { PageContent } from '@/components/ui/page-content';
import { useThemeColors, getSheetBg } from '@/lib/theme-colors';

// ─── API ─────────────────────────────────────────────────────────────────────

function useSecrets(sandboxUrl: string | undefined) {
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchSecrets = useCallback(async () => {
    if (!sandboxUrl) return;
    setIsLoading(true);
    setError(null);
    try {
      const token = await getAuthToken();
      const res = await fetch(`${sandboxUrl}/env`, {
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      });
      if (!res.ok) throw new Error(`Failed to fetch secrets: ${res.status}`);
      const data = await res.json();
      setSecrets(data.secrets ?? data ?? {});
    } catch (err: any) {
      log.error('Failed to fetch secrets:', err);
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  }, [sandboxUrl]);

  useEffect(() => { fetchSecrets(); }, [fetchSecrets]);

  return { secrets, isLoading, error, refetch: fetchSecrets };
}

async function putSecret(sandboxUrl: string, key: string, value: string): Promise<void> {
  const token = await getAuthToken();
  const res = await fetch(`${sandboxUrl}/env/${encodeURIComponent(key)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ value }),
  });
  if (!res.ok) throw new Error(`Failed to set secret: ${res.status}`);
}

async function removeSecret(sandboxUrl: string, key: string): Promise<void> {
  const token = await getAuthToken();
  const res = await fetch(`${sandboxUrl}/env/${encodeURIComponent(key)}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  if (!res.ok) throw new Error(`Failed to delete secret: ${res.status}`);
}

// ─── Secret Row ──────────────────────────────────────────────────────────────

function SecretRow({
  secretKey,
  value,
  isDark,
  visibleKeys,
  onEdit,
  onDelete,
  onToggleVisibility,
}: {
  secretKey: string;
  value: string;
  isDark: boolean;
  visibleKeys: Set<string>;
  onEdit: (key: string, value: string) => void;
  onDelete: (key: string) => void;
  onToggleVisibility: (key: string) => void;
}) {
  const isVisible = visibleKeys.has(secretKey);
  const hasValue = !!value;
  const fgColor = isDark ? '#F8F8F8' : '#121215';
  const mutedColor = isDark ? '#71717a' : '#a1a1aa';
  const borderColor = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';
  const monoFont = Platform.OS === 'ios' ? 'Menlo' : 'monospace';

  return (
    <View style={{ borderBottomWidth: 1, borderBottomColor: borderColor, paddingHorizontal: 16, paddingVertical: 12 }}>
      {/* Key name */}
      <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 4 }}>
        <Key size={12} color={mutedColor} style={{ marginRight: 6 }} />
        <Text style={{ fontSize: 13, fontFamily: monoFont, color: hasValue ? fgColor : mutedColor, flex: 1 }} numberOfLines={1}>
          {secretKey}
        </Text>
      </View>

      {/* Value + actions */}
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <Text
          style={{ flex: 1, fontSize: 12, fontFamily: monoFont, color: hasValue ? mutedColor : (isDark ? '#52525b' : '#d4d4d8') }}
          numberOfLines={1}
        >
          {!hasValue ? 'empty' : isVisible ? value : '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022'}
        </Text>
        <View style={{ flexDirection: 'row', gap: 4 }}>
          {hasValue && (
            <TouchableOpacity onPress={() => onToggleVisibility(secretKey)} style={{ padding: 6 }} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              {isVisible ? <EyeOff size={15} color={mutedColor} /> : <Eye size={15} color={mutedColor} />}
            </TouchableOpacity>
          )}
          <TouchableOpacity onPress={() => onEdit(secretKey, value)} style={{ padding: 6 }} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Pencil size={15} color={mutedColor} />
          </TouchableOpacity>
          <TouchableOpacity onPress={() => onDelete(secretKey)} style={{ padding: 6 }} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Trash2 size={15} color={mutedColor} />
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

// ─── SecretsPage ─────────────────────────────────────────────────────────────

interface SecretsPageProps {
  page: PageTab;
  onBack: () => void;
  onOpenDrawer?: () => void;
  onOpenRightDrawer?: () => void;
  isDrawerOpen?: boolean;
  isRightDrawerOpen?: boolean;
}

export function SecretsPage({ page, onBack, onOpenDrawer, onOpenRightDrawer, isDrawerOpen, isRightDrawerOpen }: SecretsPageProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const insets = useSafeAreaInsets();
  const sheetPadding = useSheetBottomPadding();
  const { sandboxUrl } = useSandboxContext();

  const fgColor = isDark ? '#F8F8F8' : '#121215';
  const mutedColor = isDark ? '#71717a' : '#a1a1aa';
  const bgColor = isDark ? '#121215' : '#F8F8F8';
  const borderColor = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';
  const sheetBg = getSheetBg(isDark);
  const inputBorder = isDark ? 'rgba(248,248,248,0.1)' : 'rgba(18,18,21,0.08)';
  const monoFont = Platform.OS === 'ios' ? 'Menlo' : 'monospace';
  const themeColors = useThemeColors();

  // Data
  const { secrets, isLoading, error, refetch } = useSecrets(sandboxUrl);

  // UI state
  const [searchQuery, setSearchQuery] = useState('');
  const [visibleKeys, setVisibleKeys] = useState<Set<string>>(new Set());
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  // Bottom sheet refs
  const addSheetRef = useRef<BottomSheetModal>(null);
  const editSheetRef = useRef<BottomSheetModal>(null);
  const deleteSheetRef = useRef<BottomSheetModal>(null);

  // Add form state
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');

  // Edit form state
  const [editKey, setEditKey] = useState('');
  const [editValue, setEditValue] = useState('');

  // Delete state
  const [deleteKey, setDeleteKey] = useState('');

  // Derived data
  const rows = useMemo(() => {
    const entries = Object.entries(secrets).map(([key, value]) => ({ key, value: value || '', hasValue: !!value }));
    entries.sort((a, b) => a.key.localeCompare(b.key));
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      return entries.filter((e) => e.key.toLowerCase().includes(q));
    }
    return entries;
  }, [secrets, searchQuery]);

  // Shared backdrop
  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} opacity={0.5} pressBehavior="close" />
    ),
    [],
  );

  const sheetStyles = useMemo(() => ({
    backgroundStyle: { backgroundColor: sheetBg, borderTopLeftRadius: 24, borderTopRightRadius: 24 },
    handleIndicatorStyle: { backgroundColor: isDark ? '#3F3F46' : '#D4D4D8', width: 36, height: 5, borderRadius: 3 },
  }), [sheetBg, isDark]);

  // ── Add ──
  const openAdd = useCallback(() => {
    setNewKey('');
    setNewValue('');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    addSheetRef.current?.present();
  }, []);

  const handleAdd = useCallback(async () => {
    if (!sandboxUrl || !newKey.trim()) return;
    setIsSaving(true);
    try {
      await putSecret(sandboxUrl, newKey.trim(), newValue);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      addSheetRef.current?.dismiss();
      refetch();
    } catch (err: any) {
      Alert.alert('Error', err.message);
    } finally {
      setIsSaving(false);
    }
  }, [sandboxUrl, newKey, newValue, refetch]);

  // ── Edit ──
  const openEdit = useCallback((key: string, value: string) => {
    setEditKey(key);
    setEditValue(value);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    editSheetRef.current?.present();
  }, []);

  const handleSave = useCallback(async () => {
    if (!sandboxUrl || !editKey) return;
    setIsSaving(true);
    try {
      await putSecret(sandboxUrl, editKey, editValue);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      editSheetRef.current?.dismiss();
      refetch();
    } catch (err: any) {
      Alert.alert('Error', err.message);
    } finally {
      setIsSaving(false);
    }
  }, [sandboxUrl, editKey, editValue, refetch]);

  // ── Delete ──
  const openDelete = useCallback((key: string) => {
    setDeleteKey(key);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    deleteSheetRef.current?.present();
  }, []);

  const handleDelete = useCallback(async () => {
    if (!sandboxUrl || !deleteKey) return;
    setIsDeleting(true);
    try {
      await removeSecret(sandboxUrl, deleteKey);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      deleteSheetRef.current?.dismiss();
      refetch();
    } catch (err: any) {
      Alert.alert('Error', err.message);
    } finally {
      setIsDeleting(false);
    }
  }, [sandboxUrl, deleteKey, refetch]);

  const handleToggleVisibility = useCallback((key: string) => {
    setVisibleKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }, []);

  return (
    <View style={{ flex: 1, backgroundColor: bgColor }}>
      <PageHeader
        title={page.label}
        onOpenDrawer={onOpenDrawer}
        onOpenRightDrawer={onOpenRightDrawer}
        isDrawerOpen={isDrawerOpen}
        isRightDrawerOpen={isRightDrawerOpen}
      />

      <PageContent>
      {/* Search + Add */}
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingBottom: 8, gap: 10 }}>
        <View
          style={{
            flex: 1,
            flexDirection: 'row',
            alignItems: 'center',
            backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)',
            borderRadius: 9999,
            paddingHorizontal: 16,
            height: 42,
          }}
        >
          <Search size={16} color={mutedColor} />
          <TextInput
            value={searchQuery}
            onChangeText={setSearchQuery}
            placeholder="Search secrets..."
            placeholderTextColor={mutedColor}
            style={{ flex: 1, marginLeft: 8, fontSize: 15, fontFamily: 'Roobert', color: fgColor }}
            returnKeyType="search"
            autoCorrect={false}
            autoCapitalize="none"
          />
          {searchQuery.length > 0 && (
            <Pressable onPress={() => setSearchQuery('')} hitSlop={8}>
              <X size={16} color={mutedColor} />
            </Pressable>
          )}
        </View>
        <Pressable
          onPress={openAdd}
          style={{
            width: 42,
            height: 42,
            borderRadius: 9999,
            backgroundColor: themeColors.primary,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Plus size={20} color={themeColors.primaryForeground} />
        </Pressable>
      </View>

      {/* List */}
      <ScrollView
        style={{ flex: 1 }}
        refreshControl={<RefreshControl refreshing={isLoading} onRefresh={refetch} tintColor={mutedColor} />}
        keyboardShouldPersistTaps="handled"
      >
        {isLoading && rows.length === 0 && (
          <View style={{ padding: 40, alignItems: 'center' }}>
            <ActivityIndicator size="large" color={mutedColor} />
          </View>
        )}
        {error && (
          <View style={{ padding: 20, alignItems: 'center' }}>
            <Text style={{ fontSize: 13, fontFamily: 'Roobert', color: isDark ? '#f87171' : '#dc2626', textAlign: 'center' }}>{error}</Text>
          </View>
        )}
        {!isLoading && !error && rows.length === 0 && (
          <View style={{ padding: 40, alignItems: 'center' }}>
            <Key size={32} color={mutedColor} style={{ marginBottom: 12, opacity: 0.5 }} />
            <Text style={{ fontSize: 14, fontFamily: 'Roobert-Medium', color: mutedColor, marginBottom: 4 }}>
              {searchQuery ? 'No secrets match your search' : 'No secrets yet'}
            </Text>
            <Text style={{ fontSize: 12, fontFamily: 'Roobert', color: mutedColor, textAlign: 'center', opacity: 0.7 }}>
              {searchQuery ? 'Try a different search term' : 'Add environment variables and API keys'}
            </Text>
          </View>
        )}
        {rows.map((row) => (
          <SecretRow
            key={row.key}
            secretKey={row.key}
            value={row.value}
            isDark={isDark}
            visibleKeys={visibleKeys}
            onEdit={openEdit}
            onDelete={openDelete}
            onToggleVisibility={handleToggleVisibility}
          />
        ))}
        <View style={{ height: insets.bottom + 80 }} />
      </ScrollView>

      {/* ── Add Secret Sheet ── */}
      <BottomSheetModal
        ref={addSheetRef}
        enableDynamicSizing
        enablePanDownToClose
        backdropComponent={renderBackdrop}
        keyboardBehavior="interactive"
        keyboardBlurBehavior="restore"
        android_keyboardInputMode="adjustResize"
        onDismiss={() => { setNewKey(''); setNewValue(''); }}
        {...sheetStyles}
      >
        <BottomSheetView style={{ paddingHorizontal: 24, paddingTop: 8, paddingBottom: sheetPadding }}>
          {/* Header */}
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 20 }}>
            <View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)', alignItems: 'center', justifyContent: 'center', marginRight: 12 }}>
              <Plus size={20} color={fgColor} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 18, fontFamily: 'Roobert-SemiBold', color: fgColor }}>New Secret</Text>
              <Text style={{ fontSize: 12, fontFamily: 'Roobert', color: mutedColor, marginTop: 2 }}>Add an environment variable</Text>
            </View>
          </View>

          {/* Key input */}
          <BottomSheetTextInput
            value={newKey}
            onChangeText={(text) => setNewKey(text.toUpperCase().replace(/[^A-Z0-9_]/g, ''))}
            placeholder="KEY_NAME"
            autoFocus
            autoCapitalize="characters"
            autoCorrect={false}
            placeholderTextColor={mutedColor}
            style={{
              borderWidth: 1, borderColor: inputBorder, borderRadius: 14,
              paddingHorizontal: 16, paddingVertical: 14, fontSize: 16,
              fontFamily: monoFont, color: fgColor, marginBottom: 10,
            }}
          />

          {/* Value input */}
          <BottomSheetTextInput
            value={newValue}
            onChangeText={setNewValue}
            placeholder="Value"
            autoCorrect={false}
            returnKeyType="done"
            onSubmitEditing={handleAdd}
            placeholderTextColor={mutedColor}
            style={{
              borderWidth: 1, borderColor: inputBorder, borderRadius: 14,
              paddingHorizontal: 16, paddingVertical: 14, fontSize: 16,
              fontFamily: monoFont, color: fgColor, marginBottom: 20,
            }}
          />

          {/* Submit */}
          <BottomSheetTouchable
            onPress={handleAdd}
            disabled={!newKey.trim() || isSaving}
            style={{
              backgroundColor: newKey.trim() ? themeColors.primary : (isDark ? 'rgba(248,248,248,0.08)' : 'rgba(18,18,21,0.06)'),
              borderRadius: 9999, paddingVertical: 15, alignItems: 'center',
              opacity: newKey.trim() && !isSaving ? 1 : 0.5,
            }}
          >
            <Text style={{ fontSize: 16, fontFamily: 'Roobert-SemiBold', color: newKey.trim() ? themeColors.primaryForeground : mutedColor }}>
              {isSaving ? 'Adding...' : 'Add Secret'}
            </Text>
          </BottomSheetTouchable>
        </BottomSheetView>
      </BottomSheetModal>

      {/* ── Edit Secret Sheet ── */}
      <BottomSheetModal
        ref={editSheetRef}
        enableDynamicSizing
        enablePanDownToClose
        backdropComponent={renderBackdrop}
        keyboardBehavior="interactive"
        keyboardBlurBehavior="restore"
        android_keyboardInputMode="adjustResize"
        onDismiss={() => { setEditKey(''); setEditValue(''); }}
        {...sheetStyles}
      >
        <BottomSheetView style={{ paddingHorizontal: 24, paddingTop: 8, paddingBottom: sheetPadding }}>
          {/* Header */}
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 20 }}>
            <View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)', alignItems: 'center', justifyContent: 'center', marginRight: 12 }}>
              <Pencil size={20} color={fgColor} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 18, fontFamily: 'Roobert-SemiBold', color: fgColor }}>Edit Secret</Text>
              <Text style={{ fontSize: 12, fontFamily: monoFont, color: mutedColor, marginTop: 2 }} numberOfLines={1}>{editKey}</Text>
            </View>
          </View>

          {/* Value input */}
          <BottomSheetTextInput
            value={editValue}
            onChangeText={setEditValue}
            placeholder="Enter new value"
            autoFocus
            autoCorrect={false}
            returnKeyType="done"
            onSubmitEditing={handleSave}
            placeholderTextColor={mutedColor}
            style={{
              borderWidth: 1, borderColor: inputBorder, borderRadius: 14,
              paddingHorizontal: 16, paddingVertical: 14, fontSize: 16,
              fontFamily: monoFont, color: fgColor, marginBottom: 20,
            }}
          />

          {/* Submit */}
          <BottomSheetTouchable
            onPress={handleSave}
            disabled={isSaving}
            style={{
              backgroundColor: themeColors.primary, borderRadius: 9999, paddingVertical: 15,
              alignItems: 'center', opacity: isSaving ? 0.5 : 1,
            }}
          >
            <Text style={{ fontSize: 16, fontFamily: 'Roobert-SemiBold', color: themeColors.primaryForeground }}>
              {isSaving ? 'Saving...' : 'Save'}
            </Text>
          </BottomSheetTouchable>
        </BottomSheetView>
      </BottomSheetModal>

      {/* ── Delete Secret Sheet ── */}
      <BottomSheetModal
        ref={deleteSheetRef}
        enableDynamicSizing
        enablePanDownToClose
        backdropComponent={renderBackdrop}
        onDismiss={() => setDeleteKey('')}
        {...sheetStyles}
      >
        <BottomSheetView style={{ paddingHorizontal: 24, paddingTop: 8, paddingBottom: sheetPadding }}>
          {/* Header */}
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 20 }}>
            <View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: isDark ? 'rgba(239,68,68,0.1)' : 'rgba(239,68,68,0.06)', alignItems: 'center', justifyContent: 'center', marginRight: 12 }}>
              <Trash2 size={20} color={isDark ? '#f87171' : '#dc2626'} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 18, fontFamily: 'Roobert-SemiBold', color: fgColor }}>Delete Secret</Text>
              <Text style={{ fontSize: 12, fontFamily: monoFont, color: mutedColor, marginTop: 2 }} numberOfLines={1}>{deleteKey}</Text>
            </View>
          </View>

          {/* Warning */}
          <View style={{
            flexDirection: 'row', alignItems: 'center', padding: 12, borderRadius: 12, marginBottom: 20,
            backgroundColor: isDark ? 'rgba(239,68,68,0.08)' : 'rgba(239,68,68,0.04)',
            borderWidth: 1, borderColor: isDark ? 'rgba(239,68,68,0.15)' : 'rgba(239,68,68,0.1)',
          }}>
            <AlertTriangle size={16} color={isDark ? '#f87171' : '#dc2626'} style={{ marginRight: 8 }} />
            <Text style={{ fontSize: 13, fontFamily: 'Roobert', color: isDark ? '#fca5a5' : '#b91c1c', flex: 1, lineHeight: 18 }}>
              This will permanently remove this environment variable.
            </Text>
          </View>

          {/* Buttons */}
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <BottomSheetTouchable
              onPress={() => deleteSheetRef.current?.dismiss()}
              style={{
                flex: 1, borderRadius: 9999, paddingVertical: 15, alignItems: 'center',
                borderWidth: 1, borderColor: borderColor,
              }}
            >
              <Text style={{ fontSize: 16, fontFamily: 'Roobert-SemiBold', color: fgColor }}>Cancel</Text>
            </BottomSheetTouchable>
            <BottomSheetTouchable
              onPress={handleDelete}
              disabled={isDeleting}
              style={{
                flex: 1, borderRadius: 9999, paddingVertical: 15, alignItems: 'center',
                backgroundColor: isDark ? '#dc2626' : '#ef4444', opacity: isDeleting ? 0.5 : 1,
              }}
            >
              <Text style={{ fontSize: 16, fontFamily: 'Roobert-SemiBold', color: '#FFFFFF' }}>
                {isDeleting ? 'Deleting...' : 'Delete'}
              </Text>
            </BottomSheetTouchable>
          </View>
        </BottomSheetView>
      </BottomSheetModal>
      </PageContent>
    </View>
  );
}
