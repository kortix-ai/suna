/**
 * Account → Groups (web parity: iam/groups-tab). Search, create, and open a
 * group; the group detail screen owns rename / members / project access /
 * delete. Settings-list layout: see apps/mobile/design.md.
 */

import React, { useMemo, useState } from 'react';
import { Alert, RefreshControl, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BottomSheetModal, BottomSheetScrollView } from '@gorhom/bottom-sheet';
import { WarningCircleIcon as AlertCircle, PlusIcon as Plus, ArrowClockwiseIcon as RotateCw } from '@/lib/icons';

import { Text } from '@/components/ui/text';
import { Button } from '@/components/ui/button';
import { Avatar } from '@/components/kortix/avatar';
import { KortixLoader } from '@/components/kortix/kortix-loader';
import { SearchBar } from '@/components/kortix/SearchBar';
import { SheetTextInput } from '@/components/kortix/SheetInput';
import { SheetBackdrop, sheetHandleIndicatorStyle, useSheetBackground } from '@/components/kortix/sheet';
import { SettingsGroup, SettingsPage, SettingsRow } from '@/components/kortix/settings-list';
import { haptics } from '@/lib/haptics';
import { listGroups, createGroup } from '@/lib/accounts/groups-client';
import type { AccountDetail } from '@/lib/accounts/accounts-client';
import { SheetCloseButton, type AccountCaps } from './account-shared';

function memberCount(n: number | null | undefined): string {
  const count = n ?? 0;
  return `${count} member${count === 1 ? '' : 's'}`;
}

export function GroupsTab({ account, can, isDark }: { account: AccountDetail; can: AccountCaps; isDark: boolean }) {
  const sheetBg = useSheetBackground();
  const router = useRouter();
  const accountId = account.account_id;
  const canCreate = can['group.create'];
  const queryClient = useQueryClient();

  const query = useQuery({ queryKey: ['account-groups', accountId], queryFn: () => listGroups(accountId), staleTime: 30_000 });
  const [search, setSearch] = useState('');
  const createRef = React.useRef<BottomSheetModal>(null);

  const groups = query.data ?? [];
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q
      ? groups.filter((g) => g.name.toLowerCase().includes(q) || (g.description?.toLowerCase().includes(q) ?? false))
      : groups;
  }, [groups, search]);

  return (
    <View style={{ flex: 1 }}>
      <SettingsPage
        refreshControl={
          <RefreshControl refreshing={query.isRefetching} onRefresh={() => void query.refetch()} />
        }>
        {canCreate && (
          <SettingsGroup>
            <SettingsRow
              icon={Plus}
              label="Create group"
              right={null}
              onPress={() => {
                haptics.tap();
                createRef.current?.present();
              }}
            />
          </SettingsGroup>
        )}

        {query.isLoading ? (
          <View className="items-center py-12">
            <KortixLoader />
          </View>
        ) : query.isError ? (
          <SettingsGroup>
            <SettingsRow icon={AlertCircle} label="Couldn't load groups" destructive />
            <SettingsRow
              icon={RotateCw}
              label="Try again"
              right={null}
              onPress={() => {
                haptics.tap();
                query.refetch();
              }}
            />
          </SettingsGroup>
        ) : groups.length === 0 ? (
          <Text variant="muted" className="py-10 text-center">
            No groups yet.
          </Text>
        ) : (
          <>
            <SearchBar value={search} onChangeText={setSearch} onClear={() => setSearch('')} placeholder="Search groups" />
            {filtered.length === 0 ? (
              <Text variant="muted" className="py-10 text-center">
                No groups match "{search.trim()}".
              </Text>
            ) : (
              <SettingsGroup title="Groups">
                {filtered.map((g) => (
                  <SettingsRow
                    key={g.group_id}
                    leading={<Avatar variant="custom" size={28} fallbackText={g.name} />}
                    label={g.name}
                    value={memberCount(g.member_count)}
                    onPress={() => {
                      haptics.tap();
                      router.push(`/accounts/${accountId}/groups/${g.group_id}`);
                    }}
                  />
                ))}
              </SettingsGroup>
            )}
          </>
        )}
      </SettingsPage>

      <BottomSheetModal
        ref={createRef}
        snapPoints={['46%']}
        enableDynamicSizing={false}
        backgroundStyle={{ backgroundColor: sheetBg }}
        handleIndicatorStyle={sheetHandleIndicatorStyle(isDark)}
        keyboardBehavior="interactive"
        keyboardBlurBehavior="restore"
        backdropComponent={SheetBackdrop}
      >
        <CreateGroupSheet
          accountId={accountId}
          isDark={isDark}
          onClose={() => createRef.current?.dismiss()}
          onCreated={(groupId) => {
            queryClient.invalidateQueries({ queryKey: ['account-groups', accountId] });
            createRef.current?.dismiss();
            router.push(`/accounts/${accountId}/groups/${groupId}`);
          }}
        />
      </BottomSheetModal>
    </View>
  );
}

function CreateGroupSheet({ accountId, onCreated, onClose, isDark }: { accountId: string; onCreated: (groupId: string) => void; onClose: () => void; isDark: boolean }) {
  const insets = useSafeAreaInsets();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const create = useMutation({
    mutationFn: () => createGroup(accountId, { name: name.trim(), description: description.trim() || undefined }),
    onSuccess: (g) => { haptics.success(); onCreated(g.group_id); },
    onError: (e: any) => Alert.alert('Unable to create group', e?.message || 'Try again in a moment.'),
  });

  return (
    <View style={{ flex: 1 }}>
      <View className="flex-row items-center gap-3 px-5 pb-2 pt-1">
        <Text variant="large" className="flex-1">
          Create group
        </Text>
        <SheetCloseButton onPress={() => { haptics.tap(); onClose(); }} isDark={isDark} />
      </View>
      <BottomSheetScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 8, gap: 12 }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <SheetTextInput value={name} onChangeText={setName} placeholder="Group name" accessibilityLabel="Group name" maxLength={128} />
        <SheetTextInput value={description} onChangeText={setDescription} placeholder="Description (optional)" accessibilityLabel="Description" maxLength={256} />
      </BottomSheetScrollView>
      <View className="px-5 pt-3" style={{ paddingBottom: insets.bottom + 16 }}>
        <Button
          size="lg"
          className="rounded-full"
          disabled={!name.trim() || create.isPending}
          onPress={() => { haptics.tap(); create.mutate(); }}
        >
          <Text>{create.isPending ? 'Creating…' : 'Create group'}</Text>
        </Button>
      </View>
    </View>
  );
}
