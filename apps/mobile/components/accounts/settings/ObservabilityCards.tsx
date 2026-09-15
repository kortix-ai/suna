/**
 * Account → Settings → Observability (web parity: AuditWebhooksCard).
 * Group: Audit webhooks — create (signing secret shown once); tap a row for
 * its details, enable/disable, or delete.
 */

import React, { useRef, useState } from 'react';
import { Alert } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Webhook } from 'lucide-react-native';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { SettingsGroup, SettingsRow } from '@/components/kortix/settings-list';
import { Sheet, SheetBody, SheetHeader, type SheetRef } from '@/components/kortix/sheet';
import { SheetTextInput } from '@/components/kortix/SheetInput';
import { haptics } from '@/lib/haptics';
import {
  listAuditWebhooks,
  createAuditWebhook,
  updateAuditWebhook,
  deleteAuditWebhook,
  type AuditWebhook,
  type CreatedAuditWebhook,
} from '@/lib/accounts/iam-client';
import { SecretSheet, type OneTimeSecret } from './SecretSheet';

const PRESETS: { label: string; prefix: string }[] = [
  { label: 'All events', prefix: '' },
  { label: 'IAM only', prefix: 'iam.' },
  { label: 'Auth lifecycle', prefix: 'auth.' },
  { label: 'Failed logins', prefix: 'auth.login.fail' },
  { label: 'Policies', prefix: 'iam.policy' },
  { label: 'Super-admin', prefix: 'iam.member.super_admin' },
];

function relative(iso: string | null): string {
  if (!iso) return 'never';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'never';
  const min = Math.floor((Date.now() - d.getTime()) / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return d.toLocaleDateString();
}

export function ObservabilityCards({ accountId, canManage }: { accountId: string; canManage: boolean; isDark?: boolean }) {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ['audit-webhooks', accountId], queryFn: () => listAuditWebhooks(accountId), staleTime: 30_000 });
  const [busyId, setBusyId] = useState<string | null>(null);
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['audit-webhooks', accountId] });

  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => updateAuditWebhook(accountId, id, { enabled }),
    onSuccess: () => { haptics.success(); invalidate(); },
    onError: (e: any) => Alert.alert('Unable to update webhook', e?.message || 'Try again in a moment.'),
    onSettled: () => setBusyId(null),
  });
  const del = useMutation({
    mutationFn: (id: string) => deleteAuditWebhook(accountId, id),
    onSuccess: () => { haptics.success(); invalidate(); },
    onError: (e: any) => Alert.alert('Unable to delete webhook', e?.message || 'Try again in a moment.'),
    onSettled: () => setBusyId(null),
  });

  const createRef = useRef<SheetRef>(null);
  const [secret, setSecret] = useState<OneTimeSecret | null>(null);
  const hooks = query.data ?? [];

  const openDetails = (h: AuditWebhook) => {
    haptics.selection();
    const lines = [
      h.url,
      h.action_prefix ? `Events: ${h.action_prefix}*` : 'Events: all',
      `Last delivered ${relative(h.last_delivered_at)}`,
      h.last_error ? `Last error ${relative(h.last_error_at)}: ${h.last_error}` : null,
    ].filter(Boolean);
    const buttons: { text: string; style?: 'cancel' | 'destructive'; onPress?: () => void }[] = canManage
      ? [
          { text: h.enabled ? 'Disable' : 'Enable', onPress: () => { haptics.tap(); setBusyId(h.webhook_id); toggle.mutate({ id: h.webhook_id, enabled: !h.enabled }); } },
          { text: 'Delete', style: 'destructive', onPress: () => { haptics.medium(); setBusyId(h.webhook_id); del.mutate(h.webhook_id); } },
          { text: 'Cancel', style: 'cancel' },
        ]
      : [{ text: 'OK', style: 'cancel' }];
    Alert.alert(h.name, lines.join('\n'), buttons);
  };

  return (
    <>
      <SettingsGroup title="Audit webhooks">
        {canManage && (
          <SettingsRow icon={Plus} label="New webhook" onPress={() => { haptics.tap(); createRef.current?.open(); }} />
        )}
        {query.isLoading ? (
          <SettingsRow icon={Webhook} label="Loading webhooks…" />
        ) : hooks.length === 0 ? (
          <SettingsRow icon={Webhook} label="No webhooks" />
        ) : (
          hooks.map((h) => (
            <SettingsRow
              key={h.webhook_id}
              icon={Webhook}
              label={h.name}
              badge={h.last_error ? 'Error' : undefined}
              value={busyId === h.webhook_id ? 'Updating…' : h.enabled ? 'On' : 'Off'}
              onPress={busyId === h.webhook_id ? undefined : () => openDetails(h)}
            />
          ))
        )}
      </SettingsGroup>

      <CreateWebhookSheet
        sheetRef={createRef}
        accountId={accountId}
        onCreated={(hook) => {
          invalidate();
          createRef.current?.close();
          setSecret({ title: `Signing secret for ${hook.name}`, value: hook.secret });
        }}
      />
      <SecretSheet secret={secret} onClose={() => setSecret(null)} />
    </>
  );
}

function CreateWebhookSheet({
  sheetRef,
  accountId,
  onCreated,
}: {
  sheetRef: React.RefObject<SheetRef | null>;
  accountId: string;
  onCreated: (hook: CreatedAuditWebhook) => void;
}) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [prefix, setPrefix] = useState('');
  const create = useMutation({
    mutationFn: () => createAuditWebhook(accountId, { name: name.trim(), url: url.trim(), action_prefix: prefix.trim() || undefined }),
    onSuccess: (hook) => {
      haptics.success();
      setName('');
      setUrl('');
      setPrefix('');
      onCreated(hook);
    },
    onError: (e: any) => Alert.alert('Unable to create webhook', e?.message || 'Try again in a moment.'),
  });
  const valid = name.trim().length > 0 && /^https?:\/\//.test(url.trim());

  return (
    <Sheet ref={sheetRef} fullScreen enablePanDownToClose>
      <SheetHeader title="New audit webhook" />
      <SheetBody className="flex-1 gap-3">
        <SheetTextInput value={name} onChangeText={setName} placeholder="Name" />
        <SheetTextInput
          value={url}
          onChangeText={setUrl}
          placeholder="https://"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          mono
        />
        <SheetTextInput
          value={prefix}
          onChangeText={setPrefix}
          placeholder="Action prefix (optional)"
          autoCapitalize="none"
          autoCorrect={false}
          mono
        />
        <SettingsGroup title="Events">
          {PRESETS.map((p) => (
            <SettingsRow
              key={p.label}
              icon={Webhook}
              label={p.label}
              checked={prefix === p.prefix}
              right={null}
              onPress={() => { haptics.selection(); setPrefix(p.prefix); }}
            />
          ))}
        </SettingsGroup>
        <Button size="lg" className="mt-2 rounded-full" disabled={!valid || create.isPending} onPress={() => create.mutate()}>
          <Text>{create.isPending ? 'Creating…' : 'Create webhook'}</Text>
        </Button>
      </SheetBody>
    </Sheet>
  );
}
