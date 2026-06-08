/**
 * Account → Settings → Observability (web parity: AuditWebhooksCard). Ship every
 * audit event to a customer endpoint (SIEM). Create (HMAC secret shown once),
 * enable/disable, delete.
 */

import React, { useState } from 'react';
import { View, TouchableOpacity, ActivityIndicator, Alert } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Clipboard from 'expo-clipboard';
import {
  BottomSheetModal,
  BottomSheetBackdrop,
  BottomSheetScrollView,
  BottomSheetTextInput,
} from '@gorhom/bottom-sheet';
import { Plus, Trash2, TriangleAlert, Copy, Check, X } from 'lucide-react-native';
import { Text } from '@/components/ui/text';
import { getSheetBg, useThemeColors } from '@/lib/theme-colors';
import { haptics } from '@/lib/haptics';
import {
  listAuditWebhooks,
  createAuditWebhook,
  updateAuditWebhook,
  deleteAuditWebhook,
  type AuditWebhook,
  type CreatedAuditWebhook,
} from '@/lib/accounts/iam-client';
import { Card, Pill, PrimaryButton, accountColors } from '../account-shared';

const MONO = 'Menlo';
const PRESETS: { label: string; prefix: string }[] = [
  { label: 'All events', prefix: '' },
  { label: 'IAM only', prefix: 'iam.' },
  { label: 'Auth lifecycle', prefix: 'auth.' },
  { label: 'Failed logins', prefix: 'auth.login.fail' },
  { label: 'Policies', prefix: 'iam.policy' },
  { label: 'Super-admin', prefix: 'iam.member.super_admin' },
];

function relative(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const min = Math.floor((Date.now() - d.getTime()) / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return d.toLocaleDateString();
}

type Sheet = { kind: 'create' } | { kind: 'secret'; hook: CreatedAuditWebhook } | null;

export function ObservabilityCards({ accountId, canManage, isDark }: { accountId: string; canManage: boolean; isDark: boolean }) {
  const c = accountColors(isDark);
  const theme = useThemeColors();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ['audit-webhooks', accountId], queryFn: () => listAuditWebhooks(accountId), staleTime: 30_000 });
  const [busyId, setBusyId] = useState<string | null>(null);
  const [sheet, setSheet] = useState<Sheet>(null);
  const sheetRef = React.useRef<BottomSheetModal>(null);
  const open = (s: NonNullable<Sheet>) => { setSheet(s); sheetRef.current?.present(); };

  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => updateAuditWebhook(accountId, id, { enabled }),
    onSuccess: () => { haptics.success(); queryClient.invalidateQueries({ queryKey: ['audit-webhooks', accountId] }); },
    onError: (e: any) => Alert.alert('Failed', e?.message || 'Failed to update webhook.'),
    onSettled: () => setBusyId(null),
  });
  const del = useMutation({
    mutationFn: (id: string) => deleteAuditWebhook(accountId, id),
    onSuccess: () => { haptics.success(); queryClient.invalidateQueries({ queryKey: ['audit-webhooks', accountId] }); },
    onError: (e: any) => Alert.alert('Failed', e?.message || 'Failed to delete webhook.'),
    onSettled: () => setBusyId(null),
  });

  const hooks = query.data ?? [];
  const confirmDelete = (h: AuditWebhook) => Alert.alert('Delete webhook', `Stop sending audit events to "${h.name}"?`, [
    { text: 'Cancel', style: 'cancel' }, { text: 'Delete', style: 'destructive', onPress: () => { haptics.medium(); setBusyId(h.webhook_id); del.mutate(h.webhook_id); } },
  ]);

  return (
    <Card isDark={isDark}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 14.5, fontFamily: 'Roobert-Medium', color: c.fg }}>Audit webhooks</Text>
          <Text style={{ fontSize: 12, color: c.muted, marginTop: 3 }}>Ship every audit event to your SIEM or log pipeline.</Text>
        </View>
        {canManage && (
          <TouchableOpacity onPress={() => open({ kind: 'create' })} activeOpacity={0.85} style={{ flexDirection: 'row', alignItems: 'center', gap: 5, paddingLeft: 11, paddingRight: 13, height: 34, borderRadius: 9999, backgroundColor: theme.primary }}>
            <Plus size={14} color={theme.primaryForeground} />
            <Text style={{ fontSize: 12.5, fontFamily: 'Roobert-Medium', color: theme.primaryForeground }}>New</Text>
          </TouchableOpacity>
        )}
      </View>

      <View style={{ marginTop: 14 }}>
        {query.isLoading ? (
          <View style={{ paddingVertical: 20, alignItems: 'center' }}><ActivityIndicator size="small" color={c.muted} /></View>
        ) : hooks.length === 0 ? (
          <View style={{ borderRadius: 12, borderWidth: 1, borderStyle: 'dashed', borderColor: c.border, paddingVertical: 22, alignItems: 'center' }}>
            <Text style={{ fontSize: 12.5, color: c.muted }}>No webhooks configured.</Text>
          </View>
        ) : (
          <View style={{ gap: 10 }}>
            {hooks.map((h) => (
              <View key={h.webhook_id} style={{ borderRadius: 12, borderWidth: 1, borderColor: c.border, padding: 12 }}>
                <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      <Text style={{ fontSize: 14, fontFamily: 'Roobert-Medium', color: c.fg }} numberOfLines={1}>{h.name}</Text>
                      <Pill label={h.enabled ? 'enabled' : 'disabled'} isDark={isDark} tone={h.enabled ? 'emerald' : 'neutral'} />
                      {h.action_prefix && <Pill label={h.action_prefix} isDark={isDark} />}
                    </View>
                    <Text style={{ fontSize: 11, fontFamily: MONO, color: c.muted, marginTop: 3 }} numberOfLines={1}>{h.url}</Text>
                    <Text style={{ fontSize: 11, color: c.muted, marginTop: 2 }}>Last delivered {relative(h.last_delivered_at)}</Text>
                    {h.last_error && (
                      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 5, marginTop: 5 }}>
                        <TriangleAlert size={12} color="#ef4444" style={{ marginTop: 1 }} />
                        <Text style={{ flex: 1, fontSize: 11, color: '#ef4444' }}>{relative(h.last_error_at)}: {h.last_error}</Text>
                      </View>
                    )}
                  </View>
                  {canManage && (busyId === h.webhook_id ? <ActivityIndicator size="small" color={c.muted} /> : (
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                      <TouchableOpacity onPress={() => { haptics.tap(); setBusyId(h.webhook_id); toggle.mutate({ id: h.webhook_id, enabled: !h.enabled }); }} style={{ paddingHorizontal: 10, height: 30, borderRadius: 9999, borderWidth: 1, borderColor: c.border, justifyContent: 'center' }}>
                        <Text style={{ fontSize: 12, fontFamily: 'Roobert-Medium', color: c.fg }}>{h.enabled ? 'Disable' : 'Enable'}</Text>
                      </TouchableOpacity>
                      <TouchableOpacity onPress={() => confirmDelete(h)} hitSlop={6} style={{ width: 30, height: 30, borderRadius: 9999, borderWidth: 1, borderColor: 'rgba(239,68,68,0.35)', alignItems: 'center', justifyContent: 'center' }}><Trash2 size={13} color="#ef4444" /></TouchableOpacity>
                    </View>
                  ))}
                </View>
              </View>
            ))}
          </View>
        )}
      </View>

      <BottomSheetModal
        ref={sheetRef}
        snapPoints={sheet?.kind === 'secret' ? ['52%'] : ['78%']}
        enableDynamicSizing={false}
        onDismiss={() => setSheet(null)}
        backgroundStyle={{ backgroundColor: getSheetBg(isDark) }}
        handleIndicatorStyle={{ backgroundColor: isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.2)' }}
        keyboardBehavior="interactive"
        keyboardBlurBehavior="restore"
        backdropComponent={(props) => <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} opacity={0.5} />}
      >
        {sheet?.kind === 'create' ? (
          <CreateSheet accountId={accountId} onClose={() => sheetRef.current?.dismiss()} isDark={isDark}
            onCreated={(hook) => { queryClient.invalidateQueries({ queryKey: ['audit-webhooks', accountId] }); setSheet({ kind: 'secret', hook }); }} />
        ) : sheet?.kind === 'secret' ? (
          <SecretSheet hook={sheet.hook} onClose={() => sheetRef.current?.dismiss()} isDark={isDark} />
        ) : (
          <View style={{ height: 1 }} />
        )}
      </BottomSheetModal>
    </Card>
  );
}

function CreateSheet({ accountId, onCreated, onClose, isDark }: { accountId: string; onCreated: (h: CreatedAuditWebhook) => void; onClose: () => void; isDark: boolean }) {
  const c = accountColors(isDark);
  const theme = useThemeColors();
  const insets = useSafeAreaInsets();
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [prefix, setPrefix] = useState('');
  const create = useMutation({
    mutationFn: () => createAuditWebhook(accountId, { name: name.trim(), url: url.trim(), action_prefix: prefix.trim() || undefined }),
    onSuccess: (h) => { haptics.success(); onCreated(h); },
    onError: (e: any) => Alert.alert('Failed', e?.message || 'Failed to create webhook.'),
  });
  const input = { height: 44, borderRadius: 11, borderWidth: 1, borderColor: c.inputBorder, backgroundColor: c.inputBg, paddingHorizontal: 12, fontSize: 14, color: c.fg, fontFamily: 'Roobert' as const };
  const valid = name.trim().length > 0 && /^https?:\/\//.test(url.trim());

  return (
    <View style={{ flex: 1 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingTop: 4, paddingBottom: 14, borderBottomWidth: 1, borderBottomColor: c.border }}>
        <Text style={{ flex: 1, fontSize: 17, fontFamily: 'Roobert-Medium', color: c.fg }}>New audit webhook</Text>
        <TouchableOpacity onPress={() => { haptics.tap(); onClose(); }} hitSlop={8} style={{ width: 30, height: 30, borderRadius: 15, backgroundColor: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)', alignItems: 'center', justifyContent: 'center' }}><X size={17} color={c.muted} /></TouchableOpacity>
      </View>
      <BottomSheetScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16 }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        <Text style={{ fontSize: 12.5, lineHeight: 18, color: c.muted, marginBottom: 16 }}>Each event is POSTed to the URL with an X-Kortix-Signature header (HMAC-SHA256 of the body).</Text>
        <Text style={{ fontSize: 12, fontFamily: 'Roobert-Medium', color: c.muted, marginBottom: 6 }}>Name</Text>
        <BottomSheetTextInput value={name} onChangeText={setName} placeholder="Splunk production" placeholderTextColor={c.muted} style={input} />
        <Text style={{ fontSize: 12, fontFamily: 'Roobert-Medium', color: c.muted, marginTop: 14, marginBottom: 6 }}>Destination URL</Text>
        <BottomSheetTextInput value={url} onChangeText={setUrl} placeholder="https://siem.corp.example/kortix/audit" placeholderTextColor={c.muted} autoCapitalize="none" autoCorrect={false} keyboardType="url" style={[input, { fontFamily: MONO, fontSize: 13 }]} />
        <Text style={{ fontSize: 12, fontFamily: 'Roobert-Medium', color: c.muted, marginTop: 14, marginBottom: 8 }}>Action prefix <Text style={{ color: c.muted, opacity: 0.7 }}>(optional)</Text></Text>
        <BottomSheetTextInput value={prefix} onChangeText={setPrefix} placeholder="iam." placeholderTextColor={c.muted} autoCapitalize="none" autoCorrect={false} style={[input, { fontFamily: MONO, fontSize: 13 }]} />
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 7, marginTop: 10 }}>
          {PRESETS.map((p) => {
            const on = prefix === p.prefix;
            return (
              <TouchableOpacity key={p.label} onPress={() => { haptics.tap(); setPrefix(p.prefix); }} style={{ paddingHorizontal: 10, height: 30, borderRadius: 9999, borderWidth: 1, borderColor: on ? theme.primary : c.border, backgroundColor: on ? theme.primaryLight : 'transparent', justifyContent: 'center' }}>
                <Text style={{ fontSize: 11.5, fontFamily: 'Roobert-Medium', color: on ? c.fg : c.muted }}>{p.label}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
      </BottomSheetScrollView>
      <View style={{ padding: 16, paddingBottom: insets.bottom + 16, borderTopWidth: 1, borderTopColor: c.border }}>
        <PrimaryButton label="Create webhook" onPress={() => create.mutate()} disabled={!valid || create.isPending} pending={create.isPending} />
      </View>
    </View>
  );
}

function SecretSheet({ hook, onClose, isDark }: { hook: CreatedAuditWebhook; onClose: () => void; isDark: boolean }) {
  const c = accountColors(isDark);
  const theme = useThemeColors();
  const insets = useSafeAreaInsets();
  const [copied, setCopied] = useState(false);
  const copy = async () => { haptics.tap(); await Clipboard.setStringAsync(hook.secret); setCopied(true); setTimeout(() => setCopied(false), 1500); };

  return (
    <View style={{ flex: 1 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingTop: 4, paddingBottom: 14, borderBottomWidth: 1, borderBottomColor: c.border }}>
        <Text style={{ flex: 1, fontSize: 17, fontFamily: 'Roobert-Medium', color: c.fg }}>Webhook created</Text>
        <TouchableOpacity onPress={() => { haptics.tap(); onClose(); }} hitSlop={8} style={{ width: 30, height: 30, borderRadius: 15, backgroundColor: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)', alignItems: 'center', justifyContent: 'center' }}><X size={17} color={c.muted} /></TouchableOpacity>
      </View>
      <BottomSheetScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16 }} showsVerticalScrollIndicator={false}>
        <Text style={{ fontSize: 12.5, lineHeight: 18, color: c.muted, marginBottom: 14 }}>Save the signing secret now — you won't see it again. To rotate, delete this webhook and create a new one.</Text>
        <Text style={{ fontSize: 11, fontFamily: 'Roobert-Medium', color: c.muted, marginBottom: 6 }}>Signing secret</Text>
        <View style={{ borderRadius: 12, borderWidth: 1, borderColor: c.inputBorder, backgroundColor: c.inputBg, padding: 12 }}>
          <Text style={{ fontSize: 12.5, lineHeight: 18, fontFamily: MONO, color: c.fg }} selectable>{hook.secret}</Text>
        </View>
        <TouchableOpacity onPress={copy} activeOpacity={0.7} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', marginTop: 12, paddingHorizontal: 14, height: 38, borderRadius: 9999, borderWidth: 1, borderColor: c.border }}>
          {copied ? <Check size={14} color={theme.primary} /> : <Copy size={14} color={c.muted} />}
          <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: copied ? theme.primary : c.fg }}>{copied ? 'Copied' : 'Copy secret'}</Text>
        </TouchableOpacity>
      </BottomSheetScrollView>
      <View style={{ padding: 16, paddingBottom: insets.bottom + 16, borderTopWidth: 1, borderTopColor: c.border }}>
        <PrimaryButton label="Done" onPress={onClose} />
      </View>
    </View>
  );
}
