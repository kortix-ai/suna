/**
 * NewAccountSheet — bottom-sheet form for creating a new account (team
 * workspace). Replaces the native Alert.prompt with branded mobile UI: a live
 * initials-avatar preview, rounded input, and a primary action. Controlled via
 * `open`; calls `onCreated` with the fresh account so callers can select +
 * navigate.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Alert, Keyboard } from 'react-native';
import { BottomSheetModal, BottomSheetView } from '@gorhom/bottom-sheet';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Text } from '@/components/ui/text';
import { SheetTextInput } from '@/components/kortix/SheetInput';
import { useToast } from '@/components/kortix/toast-provider';
import { useCreateAccount } from '@/lib/projects/hooks';
import { haptics } from '@/lib/haptics';
import type { KortixAccount } from '@/lib/projects/projects-client';
import { InitialsAvatar, PrimaryButton, SheetCloseButton, accountColors } from './account-shared';
import { KortixBottomSheetModal } from '@/components/kortix/sheet';
import { sheetOpenMove } from '@/lib/ui/sheet-open';

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

  // True while the sheet is on screen. It is mounted closed inside the
  // project switcher, and a gorhom modal dismissed before its first present
  // never renders (`sheetOpenMove`, lib/ui/sheet-open.ts).
  const presentedRef = useRef(false);
  useEffect(() => {
    const move = sheetOpenMove(open, presentedRef.current);
    if (move === 'present') {
      setName('');
      presentedRef.current = true;
      sheetRef.current?.present();
    } else if (move === 'dismiss') {
      sheetRef.current?.dismiss();
    }
  }, [open]);
  const handleDismiss = useCallback(() => {
    presentedRef.current = false;
    onClose();
  }, [onClose]);


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
    <KortixBottomSheetModal
      title="New account"
      ref={sheetRef}
      enableDynamicSizing
      enablePanDownToClose
      onDismiss={handleDismiss}
      keyboardBehavior="interactive"
      keyboardBlurBehavior="restore"
    >
      <BottomSheetView style={{ paddingHorizontal: 20, paddingTop: 6, paddingBottom: insets.bottom + 16 }}>

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
    </KortixBottomSheetModal>
  );
}
