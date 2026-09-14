/**
 * Account → Settings (web parity: Settings tab).
 * Groups: Account (name, created) · Security · Sessions · Active sessions ·
 * CLI tokens · Service accounts · Audit webhooks · Danger zone.
 */

import React, { useEffect, useRef, useState } from 'react';
import { Alert } from 'react-native';
import { Building2, CalendarDays, Trash2 } from 'lucide-react-native';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { SettingsGroup, SettingsPage, SettingsRow } from '@/components/kortix/settings-list';
import { Sheet, SheetBody, SheetHeader, type SheetRef } from '@/components/kortix/sheet';
import { SheetTextInput } from '@/components/kortix/SheetInput';
import { haptics } from '@/lib/haptics';
import { useUpdateAccountName } from '@/lib/accounts/hooks';
import type { AccountDetail } from '@/lib/accounts/accounts-client';
import type { AccountCaps } from './account-shared';
import { SecurityCards } from './settings/SecurityCards';
import { TokensCards } from './settings/TokensCards';
import { ObservabilityCards } from './settings/ObservabilityCards';

function formatDate(input: string | null | undefined) {
  if (!input) return '—';
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function AccountSettingsTab({ account, can }: { account: AccountDetail; can: AccountCaps; isDark?: boolean }) {
  const canWrite = can['account.write'];
  const canDelete = can['account.delete'];
  const renameRef = useRef<SheetRef>(null);

  return (
    <>
      <SettingsPage>
        <SettingsGroup title="Account">
          <SettingsRow
            icon={Building2}
            label="Name"
            value={account.name}
            right={canWrite ? undefined : null}
            onPress={canWrite ? () => { haptics.tap(); renameRef.current?.open(); } : undefined}
          />
          <SettingsRow icon={CalendarDays} label="Created" value={formatDate(account.created_at)} />
        </SettingsGroup>

        <SecurityCards accountId={account.account_id} canManage={canWrite} />
        <TokensCards accountId={account.account_id} canManage={canWrite} />
        <ObservabilityCards accountId={account.account_id} canManage={canWrite} />

        {canDelete && (
          <SettingsGroup title="Danger zone">
            {/* Web shows this as "coming soon" too — no delete endpoint yet. */}
            <SettingsRow icon={Trash2} label="Delete account" value="Coming soon" destructive />
          </SettingsGroup>
        )}
      </SettingsPage>

      <RenameAccountSheet sheetRef={renameRef} account={account} />
    </>
  );
}

function RenameAccountSheet({ sheetRef, account }: { sheetRef: React.RefObject<SheetRef | null>; account: AccountDetail }) {
  const update = useUpdateAccountName(account.account_id);
  const [name, setName] = useState(account.name);
  useEffect(() => { setName(account.name); }, [account.name]);

  const trimmed = name.trim();
  const dirty = trimmed.length > 0 && trimmed !== account.name;
  const save = () => {
    if (!dirty) return;
    haptics.tap();
    update.mutate(trimmed, {
      onSuccess: () => { haptics.success(); sheetRef.current?.close(); },
      onError: (e: any) => Alert.alert('Unable to rename account', e?.message || 'Try again in a moment.'),
    });
  };

  return (
    <Sheet ref={sheetRef} enablePanDownToClose onDismiss={() => setName(account.name)}>
      <SheetHeader title="Account name" />
      <SheetBody className="gap-3">
        <SheetTextInput
          value={name}
          onChangeText={setName}
          maxLength={120}
          placeholder="Account name"
          editable={!update.isPending}
          returnKeyType="done"
          onSubmitEditing={save}
        />
        <Button size="lg" className="rounded-full" disabled={!dirty || update.isPending} onPress={save}>
          <Text>{update.isPending ? 'Saving…' : 'Save'}</Text>
        </Button>
      </SheetBody>
    </Sheet>
  );
}
