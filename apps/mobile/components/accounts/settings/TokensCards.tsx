/**
 * Account → Settings → Tokens (web parity: PatPolicyCard + ServiceAccountsCard).
 * Groups: CLI tokens (require expiry, max lifetime, idle auto-revoke) ·
 * Service accounts (create → bearer shown once; tap a row to disable/delete).
 */

import React, { useRef, useState } from 'react';
import { Alert } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, CalendarClock, Hourglass, KeyRound, Plus } from 'lucide-react-native';

import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { SettingsGroup, SettingsRow } from '@/components/kortix/settings-list';
import { Sheet, SheetBody, SheetHeader, type SheetRef } from '@/components/kortix/sheet';
import { SheetTextInput } from '@/components/kortix/SheetInput';
import { haptics } from '@/lib/haptics';
import {
  getPatPolicy,
  updatePatPolicy,
  listServiceAccounts,
  createServiceAccount,
  disableServiceAccount,
  deleteServiceAccount,
  type PatPolicy,
  type ServiceAccount,
} from '@/lib/accounts/iam-client';
import { NumberFieldSheet, type NumberField } from './NumberFieldSheet';
import { SecretSheet, type OneTimeSecret } from './SecretSheet';

const MAX_LIFETIME_DAYS = 365 * 2;
const MAX_IDLE_DAYS = 365;

function relative(iso: string): string {
  const min = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (min < 1) return 'Just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(iso).toLocaleDateString();
}

const days = (n: number | null | undefined, empty: string) => (n ? `${n} ${n === 1 ? 'day' : 'days'}` : empty);

export function TokensCards({ accountId, canManage }: { accountId: string; canManage: boolean; isDark?: boolean }) {
  const queryClient = useQueryClient();

  // ── CLI token (PAT) policy ─────────────────────────────────────────────────
  const policyQuery = useQuery({ queryKey: ['iam-pat-policy', accountId], queryFn: () => getPatPolicy(accountId), staleTime: 30_000 });
  const policy = policyQuery.data;
  const savePolicy = useMutation({
    mutationFn: (patch: Partial<PatPolicy>) => updatePatPolicy(accountId, patch),
    onSuccess: () => {
      haptics.success();
      queryClient.invalidateQueries({ queryKey: ['iam-pat-policy', accountId] });
    },
    onError: (e: any) => Alert.alert('Unable to save', e?.message || 'Try again in a moment.'),
  });
  const [field, setField] = useState<NumberField | null>(null);
  const canEditPolicy = canManage && !!policy && !savePolicy.isPending;

  // ── Service accounts ───────────────────────────────────────────────────────
  const saQuery = useQuery({ queryKey: ['service-accounts', accountId], queryFn: () => listServiceAccounts(accountId), staleTime: 30_000 });
  const [busyId, setBusyId] = useState<string | null>(null);
  const invalidateSas = () => queryClient.invalidateQueries({ queryKey: ['service-accounts', accountId] });
  const disable = useMutation({
    mutationFn: (saId: string) => disableServiceAccount(accountId, saId),
    onSuccess: () => { haptics.success(); invalidateSas(); },
    onError: (e: any) => Alert.alert('Unable to disable', e?.message || 'Try again in a moment.'),
    onSettled: () => setBusyId(null),
  });
  const del = useMutation({
    mutationFn: (saId: string) => deleteServiceAccount(accountId, saId),
    onSuccess: () => { haptics.success(); invalidateSas(); },
    onError: (e: any) => Alert.alert('Unable to delete', e?.message || 'Try again in a moment.'),
    onSettled: () => setBusyId(null),
  });

  const createRef = useRef<SheetRef>(null);
  const [secret, setSecret] = useState<OneTimeSecret | null>(null);

  const sas = saQuery.data ?? [];

  const openActions = (sa: ServiceAccount) => {
    haptics.selection();
    const actions: { text: string; style?: 'cancel' | 'destructive'; onPress?: () => void }[] = [];
    if (sa.status === 'active') {
      actions.push({ text: 'Disable', onPress: () => { haptics.medium(); setBusyId(sa.service_account_id); disable.mutate(sa.service_account_id); } });
    }
    actions.push({
      text: 'Delete',
      style: 'destructive',
      onPress: () => { haptics.medium(); setBusyId(sa.service_account_id); del.mutate(sa.service_account_id); },
    });
    actions.push({ text: 'Cancel', style: 'cancel' });
    Alert.alert(sa.name, sa.status === 'active' ? 'Deleting revokes its bearer token.' : 'This service account is disabled.', actions);
  };

  const saValue = (sa: ServiceAccount) => {
    if (busyId === sa.service_account_id) return 'Updating…';
    if (sa.status !== 'active') return 'Disabled';
    return sa.last_used_at ? relative(sa.last_used_at) : 'Never used';
  };

  return (
    <>
      <SettingsGroup title="CLI tokens">
        <SettingsRow
          icon={KeyRound}
          label="Require expiry"
          right={
            <Switch
              checked={policy?.require_expiry ?? false}
              disabled={!canEditPolicy}
              onCheckedChange={(v) => { haptics.tap(); savePolicy.mutate({ require_expiry: v }); }}
            />
          }
        />
        <SettingsRow
          icon={CalendarClock}
          label="Max lifetime"
          value={policy ? days(policy.max_lifetime_days, 'No cap') : '—'}
          onPress={
            canEditPolicy
              ? () =>
                  setField({
                    title: 'Max lifetime (days)',
                    value: policy?.max_lifetime_days ?? null,
                    placeholder: 'No cap',
                    unit: 'days',
                    max: MAX_LIFETIME_DAYS,
                    onSave: (v) => savePolicy.mutate({ max_lifetime_days: v }),
                  })
              : undefined
          }
        />
        <SettingsRow
          icon={Hourglass}
          label="Idle auto-revoke"
          value={policy ? days(policy.idle_revoke_days, 'Never') : '—'}
          onPress={
            canEditPolicy
              ? () =>
                  setField({
                    title: 'Idle auto-revoke (days)',
                    value: policy?.idle_revoke_days ?? null,
                    placeholder: 'Never',
                    unit: 'days',
                    max: MAX_IDLE_DAYS,
                    onSave: (v) => savePolicy.mutate({ idle_revoke_days: v }),
                  })
              : undefined
          }
        />
      </SettingsGroup>

      <SettingsGroup title="Service accounts">
        {canManage && (
          <SettingsRow
            icon={Plus}
            label="New service account"
            onPress={() => { haptics.tap(); createRef.current?.open(); }}
          />
        )}
        {saQuery.isLoading ? (
          <SettingsRow icon={Bot} label="Loading service accounts…" />
        ) : sas.length === 0 ? (
          <SettingsRow icon={Bot} label="No service accounts" />
        ) : (
          sas.map((sa) => (
            <SettingsRow
              key={sa.service_account_id}
              icon={Bot}
              label={sa.name}
              value={saValue(sa)}
              right={null}
              onPress={canManage && busyId !== sa.service_account_id ? () => openActions(sa) : undefined}
            />
          ))
        )}
      </SettingsGroup>

      <NumberFieldSheet field={field} onClose={() => setField(null)} />

      <CreateServiceAccountSheet
        sheetRef={createRef}
        accountId={accountId}
        onCreated={(sa) => {
          invalidateSas();
          createRef.current?.close();
          setSecret({ title: `Bearer token for ${sa.name}`, value: sa.secret });
        }}
      />
      <SecretSheet secret={secret} onClose={() => setSecret(null)} />
    </>
  );
}

function CreateServiceAccountSheet({
  sheetRef,
  accountId,
  onCreated,
}: {
  sheetRef: React.RefObject<SheetRef | null>;
  accountId: string;
  onCreated: (sa: { name: string; secret: string }) => void;
}) {
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const create = useMutation({
    mutationFn: () => createServiceAccount(accountId, { name: name.trim(), description: note.trim() || undefined }),
    onSuccess: (sa) => {
      haptics.success();
      setName('');
      setNote('');
      onCreated(sa);
    },
    onError: (e: any) => Alert.alert('Unable to create', e?.message || 'Try again in a moment.'),
  });

  return (
    <Sheet ref={sheetRef} enablePanDownToClose>
      <SheetHeader title="New service account" />
      <SheetBody className="gap-3">
        <SheetTextInput value={name} onChangeText={setName} placeholder="Name" autoCapitalize="none" autoCorrect={false} />
        <SheetTextInput value={note} onChangeText={setNote} placeholder="What it's for (optional)" />
        <Button size="lg" className="rounded-full" disabled={!name.trim() || create.isPending} onPress={() => create.mutate()}>
          <Text>{create.isPending ? 'Creating…' : 'Create'}</Text>
        </Button>
      </SheetBody>
    </Sheet>
  );
}
