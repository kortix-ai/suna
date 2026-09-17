/**
 * Account → Settings → Security (web parity: MfaRequiredCard + SessionControlsCard).
 * Groups: Security (require MFA) · Sessions (lifetime, idle timeout) ·
 * Active sessions (tap to force-logout).
 */

import React, { useMemo, useState } from 'react';
import { Alert } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ClockIcon as Clock, KeyIcon as KeyRound, MonitorIcon as Monitor, TimerIcon as Timer } from '@/lib/icons';

import { Switch } from '@/components/ui/switch';
import { SettingsGroup, SettingsRow } from '@/components/kortix/settings-list';
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
} from '@/lib/accounts/iam-client';
import { NumberFieldSheet, type NumberField } from './NumberFieldSheet';

const MAX_MINUTES = 10080;

function relative(iso: string): string {
  const sec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (sec < 60) return 'Just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(iso).toLocaleDateString();
}

/** 90 → "90 min", 120 → "2 h", 2880 → "2 d". */
function formatMinutes(n: number | null | undefined, empty: string): string {
  if (!n) return empty;
  if (n % 1440 === 0) return `${n / 1440} d`;
  if (n % 60 === 0) return `${n / 60} h`;
  return `${n} min`;
}

export function SecurityCards({ accountId, canManage }: { accountId: string; canManage: boolean; isDark?: boolean }) {
  const queryClient = useQueryClient();

  // ── Require MFA ────────────────────────────────────────────────────────────
  const mfaQuery = useQuery({ queryKey: ['iam-mfa-required', accountId], queryFn: () => getMfaRequired(accountId), staleTime: 30_000 });
  const mfaEnabled = mfaQuery.data?.enabled ?? false;
  const flipMfa = useMutation({
    mutationFn: (next: boolean) => setMfaRequired(accountId, next),
    onSuccess: () => {
      haptics.success();
      queryClient.invalidateQueries({ queryKey: ['iam-mfa-required', accountId] });
      queryClient.invalidateQueries({ queryKey: ['account-capabilities'] });
    },
    onError: (e: any) => Alert.alert('Unable to update MFA', e?.message || 'Try again in a moment.'),
  });

  const onToggleMfa = async (next: boolean) => {
    if (!canManage) return;
    haptics.tap();
    if (!next) {
      Alert.alert('Turn off required MFA?', 'Members will be able to sign in without a second factor.', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Turn off', style: 'destructive', onPress: () => flipMfa.mutate(false) },
      ]);
      return;
    }
    // Enable path — check the lockout preview first.
    try {
      const preview = await previewMfaRequired(accountId);
      if (preview.will_lock_out_account) {
        Alert.alert("Can't require MFA", 'Nobody would keep access. Promote a super-admin or have a member enrol MFA first.');
        return;
      }
      const lockouts = preview.losers.filter((l) => !l.is_super_admin).length;
      const msg =
        `${preview.members_with_mfa} of ${preview.total_members} members have MFA enrolled.` +
        (lockouts > 0 ? `\n\n${lockouts} member${lockouts === 1 ? '' : 's'} will be locked out until they enrol.` : '');
      Alert.alert('Require MFA?', msg, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Require MFA', onPress: () => flipMfa.mutate(true) },
      ]);
    } catch (e: any) {
      Alert.alert('Unable to check MFA status', e?.message || 'Try again in a moment.');
    }
  };

  // ── Session policy ─────────────────────────────────────────────────────────
  const policyQuery = useQuery({ queryKey: ['iam-session-policy', accountId], queryFn: () => getSessionPolicy(accountId), staleTime: 30_000 });
  const maxLifetime = policyQuery.data?.max_lifetime_minutes ?? null;
  const idleTimeout = policyQuery.data?.idle_timeout_minutes ?? null;
  const savePolicy = useMutation({
    mutationFn: (patch: { max_lifetime_minutes: number | null; idle_timeout_minutes: number | null }) => updateSessionPolicy(accountId, patch),
    onSuccess: () => {
      haptics.success();
      queryClient.invalidateQueries({ queryKey: ['iam-session-policy', accountId] });
    },
    onError: (e: any) => Alert.alert('Unable to save', e?.message || 'Try again in a moment.'),
  });
  const [field, setField] = useState<NumberField | null>(null);

  // ── Active sessions ────────────────────────────────────────────────────────
  const sessionsQuery = useQuery({ queryKey: ['iam-sessions', accountId], queryFn: () => listAccountSessions(accountId), staleTime: 15_000 });
  const membersQuery = useAccountMembers(accountId);
  const emailByUserId = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of membersQuery.data ?? []) if (m.email) map.set(m.user_id, m.email);
    return map;
  }, [membersQuery.data]);
  const revoke = useMutation({
    mutationFn: (sessionId: string) => revokeAccountSession(accountId, sessionId),
    onSuccess: () => {
      haptics.success();
      queryClient.invalidateQueries({ queryKey: ['iam-sessions', accountId] });
    },
    onError: (e: any) => Alert.alert('Unable to sign out session', e?.message || 'Try again in a moment.'),
  });
  const live = (sessionsQuery.data ?? []).filter((s) => !s.revoked_at);

  return (
    <>
      <SettingsGroup title="Security">
        <SettingsRow
          icon={KeyRound}
          label="Require MFA"
          right={
            <Switch
              checked={mfaEnabled}
              disabled={!canManage || mfaQuery.isLoading || flipMfa.isPending}
              onCheckedChange={(v) => void onToggleMfa(v)}
            />
          }
        />
      </SettingsGroup>

      <SettingsGroup title="Sessions">
        <SettingsRow
          icon={Clock}
          label="Session lifetime"
          value={policyQuery.isLoading ? '—' : formatMinutes(maxLifetime, 'No limit')}
          onPress={
            canManage && !policyQuery.isLoading
              ? () =>
                  setField({
                    title: 'Session lifetime (minutes)',
                    value: maxLifetime,
                    placeholder: 'No limit',
                    unit: 'minutes',
                    max: MAX_MINUTES,
                    onSave: (v) => savePolicy.mutate({ max_lifetime_minutes: v, idle_timeout_minutes: idleTimeout }),
                  })
              : undefined
          }
        />
        <SettingsRow
          icon={Timer}
          label="Idle timeout"
          value={policyQuery.isLoading ? '—' : formatMinutes(idleTimeout, 'Off')}
          onPress={
            canManage && !policyQuery.isLoading
              ? () =>
                  setField({
                    title: 'Idle timeout (minutes)',
                    value: idleTimeout,
                    placeholder: 'Off',
                    unit: 'minutes',
                    max: MAX_MINUTES,
                    onSave: (v) => savePolicy.mutate({ max_lifetime_minutes: maxLifetime, idle_timeout_minutes: v }),
                  })
              : undefined
          }
        />
      </SettingsGroup>

      <SettingsGroup title="Active sessions">
        {sessionsQuery.isLoading ? (
          <SettingsRow icon={Monitor} label="Loading sessions…" />
        ) : live.length === 0 ? (
          <SettingsRow icon={Monitor} label="No active sessions" />
        ) : (
          live.map((s) => {
            const who = emailByUserId.get(s.user_id) ?? s.user_id;
            return (
              <SettingsRow
                key={`${s.user_id}|${s.session_id}`}
                icon={Monitor}
                label={who}
                value={relative(s.last_seen_at)}
                right={null}
                onPress={
                  canManage && !revoke.isPending
                    ? () =>
                        Alert.alert('Sign out this session?', `${who} will need to sign in again.`, [
                          { text: 'Cancel', style: 'cancel' },
                          { text: 'Sign out', style: 'destructive', onPress: () => { haptics.medium(); revoke.mutate(s.session_id); } },
                        ])
                    : undefined
                }
              />
            );
          })
        )}
      </SettingsGroup>

      <NumberFieldSheet field={field} onClose={() => setField(null)} />
    </>
  );
}
