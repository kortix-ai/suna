/**
 * NewAccountSheet — bottom-sheet form for creating a new account (team
 * workspace). Replaces the native Alert.prompt with branded mobile UI: a live
 * initials-avatar preview, rounded input, and a primary action. Controlled via
 * `open`; calls `onCreated` with the fresh account so callers can select +
 * navigate.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, TouchableOpacity, Alert, Keyboard } from 'react-native';
import {
  BottomSheetModal,
  BottomSheetBackdrop,
  BottomSheetView,
} from '@gorhom/bottom-sheet';
import type { BottomSheetBackdropProps } from '@gorhom/bottom-sheet';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { X } from 'lucide-react-native';
import { Text } from '@/components/ui/text';
import { SheetTextInput } from '@/components/ui/SheetInput';
import { useToast } from '@/components/ui/toast-provider';
import { getSheetBg } from '@/lib/theme-colors';
import { useCreateAccount } from '@/lib/projects/hooks';
import { haptics } from '@/lib/haptics';
import type { KortixAccount } from '@/lib/projects/projects-client';
import { InitialsAvatar, PrimaryButton, accountColors } from './account-shared';

interface NewAccountSheetProps {
  open: boolean;
  onClose: () => void;
  onCreated: (account: KortixAccount) => void;
}

export function NewAccountSheet({ open, onClose, onCreated }: NewAccountSheetProps) {
  const sheetRef = useRef<BottomSheetModal>(null);
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const insets = useSafeAreaInsets();
  const c = accountColors(isDark);
  const toast = useToast();
  const createAccount = useCreateAccount();
  const [name, setName] = useState('');

  useEffect(() => {
    if (open) {
      setName('');
      sheetRef.current?.present();
    } else {
      sheetRef.current?.dismiss();
    }
  }, [open]);

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} opacity={0.5} />
    ),
    [],
  );

  const submit = useCallback(async () => {
    const trimmed = name.trim();
    if (!trimmed || createAccount.isPending) return;
    Keyboard.dismiss();
    try {
      haptics.medium();
      const account = await createAccount.mutateAsync(trimmed);
      haptics.success();
      toast.success('Account created');
      sheetRef.current?.dismiss();
      onCreated(account);
    } catch (e: any) {
      Alert.alert('Failed', e?.message || 'Failed to create account.');
    }
  }, [name, createAccount, onCreated, toast]);

  const preview = name.trim();

  return (
    <BottomSheetModal
      ref={sheetRef}
      enableDynamicSizing
      enablePanDownToClose
      onDismiss={onClose}
      keyboardBehavior="interactive"
      keyboardBlurBehavior="restore"
      backdropComponent={renderBackdrop}
      backgroundStyle={{ backgroundColor: getSheetBg(isDark), borderTopLeftRadius: 24, borderTopRightRadius: 24 }}
      handleIndicatorStyle={{ backgroundColor: isDark ? '#3F3F46' : '#D4D4D8', width: 36, height: 5, borderRadius: 3 }}
    >
      <BottomSheetView style={{ paddingHorizontal: 20, paddingTop: 6, paddingBottom: insets.bottom + 16 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 18 }}>
          <Text style={{ flex: 1, fontSize: 20, fontFamily: 'Roobert-Semibold', color: c.fg }}>New account</Text>
          <TouchableOpacity onPress={() => { haptics.tap(); sheetRef.current?.dismiss(); }} hitSlop={8} style={{ width: 30, height: 30, borderRadius: 15, backgroundColor: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)', alignItems: 'center', justifyContent: 'center' }}>
            <X size={17} color={c.muted} />
          </TouchableOpacity>
        </View>

        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14, marginBottom: 18 }}>
          <InitialsAvatar label={preview || null} isDark={isDark} size={52} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={{ fontSize: 15, fontFamily: 'Roobert-Medium', color: preview ? c.fg : c.muted }} numberOfLines={1}>
              {preview || 'Your account name'}
            </Text>
            <Text style={{ fontSize: 12.5, lineHeight: 17, color: c.muted, marginTop: 2 }}>
              A shared workspace for your team and projects.
            </Text>
          </View>
        </View>

        <Text style={{ fontSize: 12, fontFamily: 'Roobert-Medium', color: c.muted, marginBottom: 6 }}>Account name</Text>
        <SheetTextInput
          value={name}
          onChangeText={setName}
          placeholder="Acme Inc."
          autoFocus
          autoCapitalize="words"
          returnKeyType="done"
          onSubmitEditing={submit}
        />

        <View style={{ marginTop: 18 }}>
          <PrimaryButton
            label="Create account"
            onPress={submit}
            disabled={!name.trim() || createAccount.isPending}
            pending={createAccount.isPending}
          />
        </View>
      </BottomSheetView>
    </BottomSheetModal>
  );
}
