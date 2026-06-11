/**
 * Account → Settings → Security (web parity: MfaRequiredCard + SessionControlsCard).
 *   • Require MFA for all members (with lockout-preview guard).
 *   • Advanced: session lifetime / idle timeout + active sessions with force-logout.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { View, TouchableOpacity, TextInput, ActivityIndicator, Alert, Switch, LayoutAnimation, Platform, UIManager } from 'react-native';
import { useColorScheme } from 'nativewind';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, ShieldCheck, ChevronDown, LogOut, Clock } from 'lucide-react-native';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/theme-colors';
import { haptics } from '@/lib/haptics';
import { useAccountMembers } from '@/lib/accounts/hooks';
import {
  getMfaRequired,
  previewMfaRequired,
  setMfaRequired,
  getSessionPolicy,
  updateSessionPolicy,
  listAccountSessions,
  revokeAccountSession,
  type ActiveSession,
} from '@/lib/accounts/iam-client';
import { Card, Pill, Divider, accountColors } from '../account-shared';

const MONO = 'Menlo';
const MAX_MINUTES = 10080;

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

export function SecurityCards({ accountId, canManage, isDark }: { accountId: string; canManage: boolean; isDark: boolean }) {
  const [advanced, setAdvanced] = useState(false);
  const c = accountColors(isDark);

  return (
    <View>
      <MfaCard accountId={accountId} canManage={canManage} isDark={isDark} />

      <Divider isDark={isDark} my={16} />

      <TouchableOpacity
        onPress={() => { haptics.tap(); LayoutAnimation.configureNext(LayoutAnimation.create(180, LayoutAnimation.Types.easeInEaseOut, LayoutAnimation.Properties.opacity)); setAdvanced((v) => !v); }}
        activeOpacity={0.7}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}
      >
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 14.5, fontFamily: 'Roobert-Medium', color: c.fg }}>Advanced security</Text>
          <Text style={{ fontSize: 12, color: c.muted, marginTop: 2 }}>Session lifetimes, idle timeouts, and force-logout.</Text>
        </View>
        <ChevronDown size={18} color={c.muted} style={{ transform: [{ rotate: advanced ? '180deg' : '0deg' }] }} />
      </TouchableOpacity>

      {advanced && <View style={{ marginTop: 16 }}><SessionControlsCard accountId={accountId} canManage={canManage} isDark={isDark} /></View>}
    </View>
  );
}

function MfaCard({ accountId, canManage, isDark }: { accountId: string; canManage: boolean; isDark: boolean }) {
  const { colorScheme } = useColorScheme();
  const c = accountColors(isDark);
  const queryClient = useQueryClient();
  const statusQuery = useQuery({ queryKey: ['iam-mfa-required', accountId], queryFn: () => getMfaRequired(accountId), staleTime: 30_000 });
  const enabled = statusQuery.data?.enabled ?? false;

  const flip = useMutation({
    mutationFn: (next: boolean) => setMfaRequired(accountId, next),
    onSuccess: () => { haptics.success(); queryClient.invalidateQueries({ queryKey: ['iam-mfa-required', accountId] }); queryClient.invalidateQueries({ queryKey: ['account-capabilities'] }); },
    onError: (e: any) => Alert.alert('Failed', e?.message || 'Failed to update MFA requirement.'),
  });

  const onToggle = async (next: boolean) => {
    if (!canManage) return;
    haptics.tap();
    if (!next) {
      Alert.alert('Disable MFA requirement', 'Members will be able to sign in without a second factor.', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Disable', style: 'destructive', onPress: () => flip.mutate(false) },
      ]);
      return;
    }
    // Enable path — fetch the lockout preview first.
    try {
      const preview = await previewMfaRequired(accountId);
      if (preview.will_lock_out_account) {
        Alert.alert("Can't require MFA", 'Nobody would retain access. Promote a super-admin or have a member enrol MFA first.');
        return;
      }
      const lockouts = preview.losers.filter((l) => !l.is_super_admin).length;
      const msg = `${preview.members_with_mfa} of ${preview.total_members} members have MFA enrolled.` + (lockouts > 0 ? `\n\n${lockouts} member${lockouts === 1 ? '' : 's'} will be locked out until they enrol.` : '');
      Alert.alert('Require MFA for this account?', msg, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Require MFA', onPress: () => flip.mutate(true) },
      ]);
    } catch (e: any) {
      Alert.alert('Failed', e?.message || 'Could not load MFA preview.');
    }
  };

  return (
    <Card flat isDark={isDark}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <KeyRound size={16} color={c.muted} />
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Text style={{ fontSize: 14.5, fontFamily: 'Roobert-Medium', color: c.fg }}>Require MFA</Text>
            {enabled && <Pill label="required" isDark={isDark} tone="emerald" />}
          </View>
          <Text style={{ fontSize: 12, lineHeight: 17, color: c.muted, marginTop: 3 }}>When enabled, members must complete a second factor. Super-admins and PATs are exempt.</Text>
        </View>
        {statusQuery.isLoading ? (
          <ActivityIndicator size="small" color={c.muted} />
        ) : (
          <Switch
            value={enabled}
            disabled={!canManage || flip.isPending}
            onValueChange={onToggle}
            trackColor={{ false: colorScheme === 'dark' ? '#3A3A3C' : '#E5E5E7', true: '#34C759' }}
            thumbColor="#FFFFFF"
            ios_backgroundColor={colorScheme === 'dark' ? '#3A3A3C' : '#E5E5E7'}
          />
        )}
      </View>
    </Card>
  );
}

function relative(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(iso).toLocaleDateString();
}

function SessionControlsCard({ accountId, canManage, isDark }: { accountId: string; canManage: boolean; isDark: boolean }) {
  const c = accountColors(isDark);
  const theme = useThemeColors();
  const queryClient = useQueryClient();

  const policyQuery = useQuery({ queryKey: ['iam-session-policy', accountId], queryFn: () => getSessionPolicy(accountId), staleTime: 30_000 });
  const sessionsQuery = useQuery({ queryKey: ['iam-sessions', accountId], queryFn: () => listAccountSessions(accountId), staleTime: 15_000 });
  const membersQuery = useAccountMembers(accountId);
  const emailByUserId = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of membersQuery.data ?? []) if (m.email) map.set(m.user_id, m.email);
    return map;
  }, [membersQuery.data]);

  const [maxLifetime, setMaxLifetime] = useState('');
  const [idleTimeout, setIdleTimeout] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!policyQuery.data) return;
    setMaxLifetime(policyQuery.data.max_lifetime_minutes?.toString() ?? '');
    setIdleTimeout(policyQuery.data.idle_timeout_minutes?.toString() ?? '');
  }, [policyQuery.data]);

  const save = useMutation({
    mutationFn: (patch: { max_lifetime_minutes: number | null; idle_timeout_minutes: number | null }) => updateSessionPolicy(accountId, patch),
    onSuccess: () => { haptics.success(); setError(null); queryClient.invalidateQueries({ queryKey: ['iam-session-policy', accountId] }); },
    onError: (e: any) => Alert.alert('Failed', e?.message || 'Failed to update policy.'),
  });
  const revoke = useMutation({
    mutationFn: (sessionId: string) => revokeAccountSession(accountId, sessionId),
    onSuccess: () => { haptics.success(); queryClient.invalidateQueries({ queryKey: ['iam-sessions', accountId] }); },
    onError: (e: any) => Alert.alert('Failed', e?.message || 'Failed to revoke session.'),
  });

  const parseField = (label: string, raw: string): number | null | { err: string } => {
    const t = raw.trim();
    if (t === '') return null;
    const n = Number(t);
    if (!Number.isInteger(n) || n <= 0) return { err: `${label} must be a positive integer or blank` };
    if (n > MAX_MINUTES) return { err: `${label} cannot exceed ${MAX_MINUTES} minutes (7 days)` };
    return n;
  };
  const handleSave = () => {
    const max = parseField('Max lifetime', maxLifetime);
    if (typeof max === 'object' && max && 'err' in max) { setError(max.err); return; }
    const idle = parseField('Idle timeout', idleTimeout);
    if (typeof idle === 'object' && idle && 'err' in idle) { setError(idle.err); return; }
    setError(null);
    haptics.tap();
    save.mutate({ max_lifetime_minutes: max as number | null, idle_timeout_minutes: idle as number | null });
  };

  const sessions = sessionsQuery.data ?? [];
  const live = sessions.filter((s) => !s.revoked_at);
  const input = { height: 44, borderRadius: 9999, borderWidth: 1, borderColor: c.inputBorder, backgroundColor: c.inputBg, paddingHorizontal: 16, fontSize: 14, color: c.fg, fontFamily: MONO } as const;

  return (
    <Card flat isDark={isDark}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <ShieldCheck size={16} color={c.muted} />
        <Text style={{ fontSize: 14.5, fontFamily: 'Roobert-Medium', color: c.fg }}>Session controls</Text>
      </View>
      <Text style={{ fontSize: 12, color: c.muted, marginTop: 3 }}>Cap how long a browser session lives; force-logout active sessions.</Text>

      {/* Policy form */}
      <View style={{ flexDirection: 'row', gap: 12, marginTop: 14 }}>
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 11.5, fontFamily: 'Roobert-Medium', color: c.muted, marginBottom: 6 }}>Max lifetime (min)</Text>
          <TextInput value={maxLifetime} onChangeText={(t) => setMaxLifetime(t.replace(/[^0-9]/g, ''))} editable={canManage && !save.isPending} keyboardType="number-pad" placeholder="No max" placeholderTextColor={c.muted} style={input} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 11.5, fontFamily: 'Roobert-Medium', color: c.muted, marginBottom: 6 }}>Idle timeout (min)</Text>
          <TextInput value={idleTimeout} onChangeText={(t) => setIdleTimeout(t.replace(/[^0-9]/g, ''))} editable={canManage && !save.isPending} keyboardType="number-pad" placeholder="No gate" placeholderTextColor={c.muted} style={input} />
        </View>
      </View>
      {error && <Text style={{ fontSize: 11.5, color: '#ef4444', marginTop: 8 }}>{error}</Text>}
      {canManage && (
        <TouchableOpacity onPress={handleSave} disabled={save.isPending} activeOpacity={0.85} style={{ alignSelf: 'flex-end', flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 18, height: 40, borderRadius: 9999, backgroundColor: theme.primary, marginTop: 12 }}>
          {save.isPending && <ActivityIndicator size="small" color={theme.primaryForeground} />}
          <Text style={{ fontSize: 14, fontFamily: 'Roobert-Medium', color: theme.primaryForeground }}>Save</Text>
        </TouchableOpacity>
      )}

      {/* Active sessions */}
      <View style={{ marginTop: 18, paddingTop: 16, borderTopWidth: 1, borderTopColor: c.border }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 10 }}>
          <Clock size={13} color={c.muted} />
          <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: c.fg }}>Active sessions</Text>
        </View>
        {sessionsQuery.isLoading ? (
          <ActivityIndicator size="small" color={c.muted} />
        ) : live.length === 0 ? (
          <Text style={{ fontSize: 12.5, color: c.muted }}>No active sessions tracked yet.</Text>
        ) : (
          <View style={{ gap: 2 }}>
            {live.map((s) => (
              <SessionRow key={`${s.user_id}|${s.session_id}`} s={s} label={emailByUserId.get(s.user_id) ?? s.user_id} canManage={canManage} pending={revoke.isPending} isDark={isDark}
                onRevoke={() => Alert.alert('Force-logout this session?', `${emailByUserId.get(s.user_id) ?? s.user_id} must sign in again.`, [
                  { text: 'Cancel', style: 'cancel' },
                  { text: 'Force-logout', style: 'destructive', onPress: () => { haptics.medium(); revoke.mutate(s.session_id); } },
                ])}
              />
            ))}
          </View>
        )}
      </View>
    </Card>
  );
}

function SessionRow({ s, label, canManage, pending, isDark, onRevoke }: { s: ActiveSession; label: string; canManage: boolean; pending: boolean; isDark: boolean; onRevoke: () => void }) {
  const c = accountColors(isDark);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8 }}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: c.fg }} numberOfLines={1}>{label}</Text>
        <Text style={{ fontSize: 11, color: c.muted, marginTop: 1 }}>{relative(s.last_seen_at)}{s.ip ? ` · ${s.ip}` : ''}</Text>
      </View>
      {canManage && (
        <TouchableOpacity onPress={onRevoke} disabled={pending} hitSlop={8} style={{ width: 32, height: 32, borderRadius: 9999, alignItems: 'center', justifyContent: 'center' }}>
          <LogOut size={15} color="#ef4444" />
        </TouchableOpacity>
      )}
    </View>
  );
}
