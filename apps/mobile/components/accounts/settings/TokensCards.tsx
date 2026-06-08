/**
 * Account → Settings → Tokens & automation (web parity: PatPolicyCard +
 * ServiceAccountsCard). PAT lifecycle policy + machine-identity service accounts
 * (create → show bearer once, disable, delete).
 */

import React, { useEffect, useState } from 'react';
import { View, TouchableOpacity, TextInput, ActivityIndicator, Alert, Switch } from 'react-native';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Clipboard from 'expo-clipboard';
import {
  BottomSheetModal,
  BottomSheetBackdrop,
  BottomSheetScrollView,
  BottomSheetTextInput,
} from '@gorhom/bottom-sheet';
import { KeyRound, Bot, Plus, CirclePause, Trash2, Copy, Check, X } from 'lucide-react-native';
import { Text } from '@/components/ui/text';
import { getSheetBg, useThemeColors } from '@/lib/theme-colors';
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
  type CreatedServiceAccount,
} from '@/lib/accounts/iam-client';
import { Card, Pill, PrimaryButton, Divider, accountColors } from '../account-shared';

const MONO = 'Menlo';
const MAX_LIFETIME = 365 * 2;
const MAX_IDLE = 365;

function relative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function TokensCards({ accountId, canManage, isDark }: { accountId: string; canManage: boolean; isDark: boolean }) {
  return (
    <View>
      <PatPolicyCard accountId={accountId} canManage={canManage} isDark={isDark} />
      <Divider isDark={isDark} my={16} />
      <ServiceAccountsCard accountId={accountId} canManage={canManage} isDark={isDark} />
    </View>
  );
}

function PatPolicyCard({ accountId, canManage, isDark }: { accountId: string; canManage: boolean; isDark: boolean }) {
  const { colorScheme } = useColorScheme();
  const c = accountColors(isDark);
  const theme = useThemeColors();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ['iam-pat-policy', accountId], queryFn: () => getPatPolicy(accountId), staleTime: 30_000 });

  const [maxLifetime, setMaxLifetime] = useState('');
  const [idleRevoke, setIdleRevoke] = useState('');
  const [requireExpiry, setRequireExpiry] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!query.data) return;
    setMaxLifetime(query.data.max_lifetime_days?.toString() ?? '');
    setIdleRevoke(query.data.idle_revoke_days?.toString() ?? '');
    setRequireExpiry(query.data.require_expiry);
  }, [query.data]);

  const save = useMutation({
    mutationFn: (patch: Partial<PatPolicy>) => updatePatPolicy(accountId, patch),
    onSuccess: () => { haptics.success(); setError(null); queryClient.invalidateQueries({ queryKey: ['iam-pat-policy', accountId] }); },
    onError: (e: any) => Alert.alert('Failed', e?.message || 'Failed to update PAT policy.'),
  });

  const parseDays = (label: string, raw: string, max: number): number | null | { err: string } => {
    const t = raw.trim();
    if (t === '') return null;
    const n = Number(t);
    if (!Number.isInteger(n) || n <= 0) return { err: `${label} must be a positive integer or blank` };
    if (n > max) return { err: `${label} cannot exceed ${max} days` };
    return n;
  };
  const handleSave = () => {
    const lifetime = parseDays('Max lifetime', maxLifetime, MAX_LIFETIME);
    if (typeof lifetime === 'object' && lifetime && 'err' in lifetime) { setError(lifetime.err); return; }
    const idle = parseDays('Idle revoke', idleRevoke, MAX_IDLE);
    if (typeof idle === 'object' && idle && 'err' in idle) { setError(idle.err); return; }
    setError(null);
    haptics.tap();
    save.mutate({ max_lifetime_days: lifetime as number | null, idle_revoke_days: idle as number | null, require_expiry: requireExpiry });
  };

  const input = { height: 44, borderRadius: 9999, borderWidth: 1, borderColor: c.inputBorder, backgroundColor: c.inputBg, paddingHorizontal: 16, fontSize: 14, color: c.fg, fontFamily: MONO } as const;

  return (
    <Card flat isDark={isDark}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <KeyRound size={16} color={c.muted} />
        <Text style={{ fontSize: 14.5, fontFamily: 'Roobert-Medium', color: c.fg }}>CLI token lifecycle</Text>
      </View>
      <Text style={{ fontSize: 12, color: c.muted, marginTop: 3 }}>Applies to Personal Access Tokens (CLI / programmatic clients).</Text>

      {query.isLoading ? (
        <View style={{ paddingVertical: 20, alignItems: 'center' }}><ActivityIndicator size="small" color={c.muted} /></View>
      ) : (
        <>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 14 }}>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 14, fontFamily: 'Roobert-Medium', color: c.fg }}>Require expiry on every PAT</Text>
              <Text style={{ fontSize: 11.5, color: c.muted, marginTop: 2 }}>Refuses minting tokens without an expires_at.</Text>
            </View>
            <Switch value={requireExpiry} disabled={!canManage || save.isPending} onValueChange={(v) => { haptics.tap(); setRequireExpiry(v); }}
              trackColor={{ false: colorScheme === 'dark' ? '#3A3A3C' : '#E5E5E7', true: '#34C759' }} thumbColor="#FFFFFF" ios_backgroundColor={colorScheme === 'dark' ? '#3A3A3C' : '#E5E5E7'} />
          </View>
          <View style={{ flexDirection: 'row', gap: 12, marginTop: 14 }}>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 11.5, fontFamily: 'Roobert-Medium', color: c.muted, marginBottom: 6 }}>Max lifetime (days)</Text>
              <TextInput value={maxLifetime} onChangeText={(t) => setMaxLifetime(t.replace(/[^0-9]/g, ''))} editable={canManage && !save.isPending} keyboardType="number-pad" placeholder="No cap" placeholderTextColor={c.muted} style={input} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 11.5, fontFamily: 'Roobert-Medium', color: c.muted, marginBottom: 6 }}>Idle auto-revoke (days)</Text>
              <TextInput value={idleRevoke} onChangeText={(t) => setIdleRevoke(t.replace(/[^0-9]/g, ''))} editable={canManage && !save.isPending} keyboardType="number-pad" placeholder="Never" placeholderTextColor={c.muted} style={input} />
            </View>
          </View>
          {error && <Text style={{ fontSize: 11.5, color: '#ef4444', marginTop: 8 }}>{error}</Text>}
          {canManage && (
            <TouchableOpacity onPress={handleSave} disabled={save.isPending} activeOpacity={0.85} style={{ alignSelf: 'flex-end', flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 18, height: 40, borderRadius: 9999, backgroundColor: theme.primary, marginTop: 12 }}>
              {save.isPending && <ActivityIndicator size="small" color={theme.primaryForeground} />}
              <Text style={{ fontSize: 14, fontFamily: 'Roobert-Medium', color: theme.primaryForeground }}>Save policy</Text>
            </TouchableOpacity>
          )}
        </>
      )}
    </Card>
  );
}

type SaSheet = { kind: 'create' } | { kind: 'bearer'; sa: CreatedServiceAccount } | null;

function ServiceAccountsCard({ accountId, canManage, isDark }: { accountId: string; canManage: boolean; isDark: boolean }) {
  const c = accountColors(isDark);
  const theme = useThemeColors();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ['service-accounts', accountId], queryFn: () => listServiceAccounts(accountId), staleTime: 30_000 });
  const [busyId, setBusyId] = useState<string | null>(null);
  const [sheet, setSheet] = useState<SaSheet>(null);
  const sheetRef = React.useRef<BottomSheetModal>(null);
  const open = (s: NonNullable<SaSheet>) => setSheet(s);
  useEffect(() => { if (sheet) sheetRef.current?.present(); }, [sheet]);

  const disable = useMutation({
    mutationFn: (saId: string) => disableServiceAccount(accountId, saId),
    onSuccess: () => { haptics.success(); queryClient.invalidateQueries({ queryKey: ['service-accounts', accountId] }); },
    onError: (e: any) => Alert.alert('Failed', e?.message || 'Failed to disable.'),
    onSettled: () => setBusyId(null),
  });
  const del = useMutation({
    mutationFn: (saId: string) => deleteServiceAccount(accountId, saId),
    onSuccess: () => { haptics.success(); queryClient.invalidateQueries({ queryKey: ['service-accounts', accountId] }); },
    onError: (e: any) => Alert.alert('Failed', e?.message || 'Failed to delete.'),
    onSettled: () => setBusyId(null),
  });

  const sas = query.data ?? [];
  const confirmDisable = (sa: ServiceAccount) => Alert.alert('Disable service account', `"${sa.name}" will start failing auth on its next request.`, [
    { text: 'Cancel', style: 'cancel' }, { text: 'Disable', style: 'destructive', onPress: () => { haptics.medium(); setBusyId(sa.service_account_id); disable.mutate(sa.service_account_id); } },
  ]);
  const confirmDelete = (sa: ServiceAccount) => Alert.alert('Delete service account', `Permanently removes "${sa.name}" and revokes its bearer.`, [
    { text: 'Cancel', style: 'cancel' }, { text: 'Delete', style: 'destructive', onPress: () => { haptics.medium(); setBusyId(sa.service_account_id); del.mutate(sa.service_account_id); } },
  ]);

  return (
    <Card flat isDark={isDark}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Bot size={16} color={c.muted} />
            <Text style={{ fontSize: 14.5, fontFamily: 'Roobert-Medium', color: c.fg }}>Service accounts</Text>
          </View>
          <Text style={{ fontSize: 12, color: c.muted, marginTop: 3 }}>Machine identities for CI/CD and integrations.</Text>
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
        ) : sas.length === 0 ? (
          <Text style={{ fontSize: 12.5, color: c.muted }}>No service accounts yet. Create one to get a bearer token.</Text>
        ) : (
          <View style={{ borderRadius: 12, borderWidth: 1, borderColor: c.border, overflow: 'hidden' }}>
            {sas.map((sa, i) => (
              <View key={sa.service_account_id} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: c.border }}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <Text style={{ fontSize: 14, fontFamily: 'Roobert-Medium', color: c.fg }} numberOfLines={1}>{sa.name}</Text>
                    <Pill label={sa.status} isDark={isDark} tone={sa.status === 'active' ? 'emerald' : 'neutral'} />
                  </View>
                  <Text style={{ fontSize: 11, fontFamily: MONO, color: c.muted, marginTop: 2 }} numberOfLines={1}>{sa.public_prefix} · {sa.last_used_at ? relative(sa.last_used_at) : 'never used'}</Text>
                </View>
                {canManage && (busyId === sa.service_account_id ? <ActivityIndicator size="small" color={c.muted} /> : (
                  <View style={{ flexDirection: 'row', gap: 6 }}>
                    {sa.status === 'active' && (
                      <TouchableOpacity onPress={() => confirmDisable(sa)} hitSlop={6} style={{ width: 32, height: 32, borderRadius: 9999, borderWidth: 1, borderColor: c.border, alignItems: 'center', justifyContent: 'center' }}><CirclePause size={14} color="#d97706" /></TouchableOpacity>
                    )}
                    <TouchableOpacity onPress={() => confirmDelete(sa)} hitSlop={6} style={{ width: 32, height: 32, borderRadius: 9999, borderWidth: 1, borderColor: 'rgba(239,68,68,0.35)', alignItems: 'center', justifyContent: 'center' }}><Trash2 size={14} color="#ef4444" /></TouchableOpacity>
                  </View>
                ))}
              </View>
            ))}
          </View>
        )}
      </View>

      <BottomSheetModal
        ref={sheetRef}
        snapPoints={sheet?.kind === 'bearer' ? ['50%'] : ['56%']}
        enableDynamicSizing={false}
        onDismiss={() => setSheet(null)}
        backgroundStyle={{ backgroundColor: getSheetBg(isDark) }}
        handleIndicatorStyle={{ backgroundColor: isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.2)' }}
        keyboardBehavior="interactive"
        keyboardBlurBehavior="restore"
        backdropComponent={(props) => <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} opacity={0.5} />}
      >
        {sheet?.kind === 'create' ? (
          <CreateSaSheet accountId={accountId} onClose={() => sheetRef.current?.dismiss()} isDark={isDark}
            onCreated={(sa) => { queryClient.invalidateQueries({ queryKey: ['service-accounts', accountId] }); setSheet({ kind: 'bearer', sa }); }} />
        ) : sheet?.kind === 'bearer' ? (
          <BearerSheet sa={sheet.sa} onClose={() => sheetRef.current?.dismiss()} isDark={isDark} />
        ) : (
          <View style={{ height: 1 }} />
        )}
      </BottomSheetModal>
    </Card>
  );
}

function CreateSaSheet({ accountId, onCreated, onClose, isDark }: { accountId: string; onCreated: (sa: CreatedServiceAccount) => void; onClose: () => void; isDark: boolean }) {
  const c = accountColors(isDark);
  const insets = useSafeAreaInsets();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const create = useMutation({
    mutationFn: () => createServiceAccount(accountId, { name: name.trim(), description: description.trim() || undefined }),
    onSuccess: (sa) => { haptics.success(); onCreated(sa); },
    onError: (e: any) => Alert.alert('Failed', e?.message || 'Failed to create service account.'),
  });
  const input = { height: 44, borderRadius: 9999, borderWidth: 1, borderColor: c.inputBorder, backgroundColor: c.inputBg, paddingHorizontal: 16, fontSize: 14, color: c.fg, fontFamily: 'Roobert' as const };

  return (
    <View style={{ flex: 1 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingTop: 4, paddingBottom: 14, borderBottomWidth: 1, borderBottomColor: c.border }}>
        <Bot size={18} color={c.fg} />
        <Text style={{ flex: 1, fontSize: 17, fontFamily: 'Roobert-Medium', color: c.fg }}>New service account</Text>
        <TouchableOpacity onPress={() => { haptics.tap(); onClose(); }} hitSlop={8} style={{ width: 30, height: 30, borderRadius: 15, backgroundColor: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)', alignItems: 'center', justifyContent: 'center' }}><X size={17} color={c.muted} /></TouchableOpacity>
      </View>
      <BottomSheetScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16 }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        <Text style={{ fontSize: 12.5, color: c.muted, marginBottom: 16 }}>A bearer token will be shown once, right after creation.</Text>
        <Text style={{ fontSize: 12, fontFamily: 'Roobert-Medium', color: c.muted, marginBottom: 6 }}>Name</Text>
        <BottomSheetTextInput value={name} onChangeText={setName} placeholder="ci-deploy" placeholderTextColor={c.muted} autoCapitalize="none" autoCorrect={false} style={input} />
        <Text style={{ fontSize: 12, fontFamily: 'Roobert-Medium', color: c.muted, marginTop: 14, marginBottom: 6 }}>Description (optional)</Text>
        <BottomSheetTextInput value={description} onChangeText={setDescription} placeholder="GitHub Actions deploy worker" placeholderTextColor={c.muted} style={input} />
      </BottomSheetScrollView>
      <View style={{ padding: 16, paddingBottom: insets.bottom + 16, borderTopWidth: 1, borderTopColor: c.border }}>
        <PrimaryButton label="Create" onPress={() => create.mutate()} disabled={!name.trim() || create.isPending} pending={create.isPending} />
      </View>
    </View>
  );
}

function BearerSheet({ sa, onClose, isDark }: { sa: CreatedServiceAccount; onClose: () => void; isDark: boolean }) {
  const c = accountColors(isDark);
  const theme = useThemeColors();
  const insets = useSafeAreaInsets();
  const [copied, setCopied] = useState(false);
  const copy = async () => { haptics.tap(); await Clipboard.setStringAsync(sa.secret); setCopied(true); setTimeout(() => setCopied(false), 1500); };

  return (
    <View style={{ flex: 1 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingTop: 4, paddingBottom: 14, borderBottomWidth: 1, borderBottomColor: c.border }}>
        <KeyRound size={18} color={c.fg} />
        <Text style={{ flex: 1, fontSize: 17, fontFamily: 'Roobert-Medium', color: c.fg }}>Save this bearer now</Text>
        <TouchableOpacity onPress={() => { haptics.tap(); onClose(); }} hitSlop={8} style={{ width: 30, height: 30, borderRadius: 15, backgroundColor: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)', alignItems: 'center', justifyContent: 'center' }}><X size={17} color={c.muted} /></TouchableOpacity>
      </View>
      <BottomSheetScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16 }} showsVerticalScrollIndicator={false}>
        <Text style={{ fontSize: 12.5, lineHeight: 18, color: c.muted, marginBottom: 14 }}>This is the only time we'll show <Text style={{ fontFamily: 'Roobert-Medium', color: c.fg }}>{sa.name}</Text>'s secret. Store it in your secrets manager.</Text>
        <View style={{ borderRadius: 12, borderWidth: 1, borderColor: c.inputBorder, backgroundColor: c.inputBg, padding: 12 }}>
          <Text style={{ fontSize: 12.5, lineHeight: 18, fontFamily: MONO, color: c.fg }} selectable>{sa.secret}</Text>
        </View>
        <TouchableOpacity onPress={copy} activeOpacity={0.7} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', marginTop: 12, paddingHorizontal: 14, height: 38, borderRadius: 9999, borderWidth: 1, borderColor: c.border }}>
          {copied ? <Check size={14} color={theme.primary} /> : <Copy size={14} color={c.muted} />}
          <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: copied ? theme.primary : c.fg }}>{copied ? 'Copied' : 'Copy bearer'}</Text>
        </TouchableOpacity>
      </BottomSheetScrollView>
      <View style={{ padding: 16, paddingBottom: insets.bottom + 16, borderTopWidth: 1, borderTopColor: c.border }}>
        <PrimaryButton label="Done" onPress={onClose} />
      </View>
    </View>
  );
}
