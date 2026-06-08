/**
 * Account → Audit (web parity: iam/audit-tab). Cursor-paginated audit log with
 * quick filters, humanised action titles, expandable before/after diff, and
 * CSV/JSONL export (shared as a file on mobile).
 */

import React, { useMemo, useState } from 'react';
import { View, TouchableOpacity, ScrollView, ActivityIndicator, Alert, RefreshControl } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useInfiniteQuery } from '@tanstack/react-query';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { Download, ChevronDown, ChevronRight } from 'lucide-react-native';
import { Text } from '@/components/ui/text';
import { haptics } from '@/lib/haptics';
import { API_URL, getAuthToken } from '@/api/config';
import { useAuthContext } from '@/contexts';
import { useAccountMembers } from '@/lib/accounts/hooks';
import { listAuditEvents } from '@/lib/accounts/accounts-client';
import type { AccountDetail, AuditEvent } from '@/lib/accounts/accounts-client';
import { humanizeAuditAction, formatResourcePill, KIND_DOT_COLOR } from '@/lib/accounts/audit-display';
import { accountColors, SkeletonList } from './account-shared';

const MONO = 'Menlo';

interface QuickFilter { label: string; action: string | null; daysBack: number | null }
const QUICK_FILTERS: QuickFilter[] = [
  { label: 'All events', action: null, daysBack: null },
  { label: 'IAM only', action: 'iam.', daysBack: null },
  { label: 'Group changes', action: 'iam.group', daysBack: null },
  { label: 'Project access', action: 'iam.project.group', daysBack: null },
  { label: 'Super-admin', action: 'iam.member.super_admin', daysBack: null },
  { label: 'Last 24h', action: null, daysBack: 1 },
  { label: 'Last 7d', action: null, daysBack: 7 },
  { label: 'Last 30d', action: null, daysBack: 30 },
];

const daysAgoIso = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

function relative(d: Date): string {
  const minutes = Math.floor((Date.now() - d.getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return d.toLocaleDateString();
}

export function AuditTab({ account, isDark }: { account: AccountDetail; isDark: boolean }) {
  const c = accountColors(isDark);
  const insets = useSafeAreaInsets();
  const { user } = useAuthContext();
  const accountId = account.account_id;
  const [filterIndex, setFilterIndex] = useState(0);
  const [exporting, setExporting] = useState(false);
  const active = QUICK_FILTERS[filterIndex];

  const query = useInfiniteQuery({
    queryKey: ['audit', accountId, active.action, active.daysBack],
    queryFn: ({ pageParam }) => listAuditEvents(accountId, {
      action: active.action ?? undefined,
      since: active.daysBack ? daysAgoIso(active.daysBack) : undefined,
      cursor: pageParam,
      limit: 50,
    }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });

  const membersQuery = useAccountMembers(accountId);
  const emailByUserId = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of membersQuery.data ?? []) if (m.email) map.set(m.user_id, m.email);
    return map;
  }, [membersQuery.data]);

  const events: AuditEvent[] = useMemo(() => (query.data?.pages ?? []).flatMap((p) => p.events), [query.data]);

  const exportEvents = (format: 'csv' | 'jsonl') => {
    haptics.tap();
    setExporting(true);
    (async () => {
      try {
        const token = await getAuthToken();
        if (!token) { Alert.alert('Not signed in'); return; }
        const params = new URLSearchParams({ format });
        if (active.action) params.set('action', active.action);
        if (active.daysBack) params.set('since', daysAgoIso(active.daysBack));
        const res = await fetch(`${API_URL}/accounts/${accountId}/audit/export?${params.toString()}`, { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) { Alert.alert('Export failed', `${res.status}`); return; }
        const text = await res.text();
        const filename = `audit-${new Date().toISOString().slice(0, 10)}.${format}`;
        const target = `${FileSystem.cacheDirectory}${filename}`;
        await FileSystem.writeAsStringAsync(target, text);
        if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(target);
      } catch (e: any) {
        Alert.alert('Export failed', e?.message || 'Could not export audit log.');
      } finally {
        setExporting(false);
      }
    })();
  };

  return (
    <View style={{ flex: 1 }}>
      {/* Filters + export */}
      <View style={{ borderBottomWidth: 1, borderBottomColor: c.border }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 4 }}>
          <Text style={{ flex: 1, fontSize: 11, fontFamily: 'Roobert-Medium', color: c.muted, textTransform: 'uppercase', letterSpacing: 0.5 }}>Audit log</Text>
          <TouchableOpacity onPress={() => exporting ? null : Alert.alert('Export audit log', 'Choose a format', [
            { text: 'CSV', onPress: () => exportEvents('csv') },
            { text: 'JSONL', onPress: () => exportEvents('jsonl') },
            { text: 'Cancel', style: 'cancel' },
          ])} disabled={exporting} activeOpacity={0.7} style={{ flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 11, height: 30, borderRadius: 9999, borderWidth: 1, borderColor: c.border }}>
            {exporting ? <ActivityIndicator size="small" color={c.muted} /> : <Download size={13} color={c.muted} />}
            <Text style={{ fontSize: 12.5, fontFamily: 'Roobert-Medium', color: c.fg }}>Export</Text>
          </TouchableOpacity>
        </View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 12, gap: 7 }}>
          {QUICK_FILTERS.map((f, i) => {
            const on = filterIndex === i;
            return (
              <TouchableOpacity key={f.label} onPress={() => { haptics.selection(); setFilterIndex(i); }} activeOpacity={0.7} style={{ paddingHorizontal: 12, height: 30, borderRadius: 9999, borderWidth: 1, borderColor: on ? (isDark ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.3)') : c.border, backgroundColor: on ? c.avatarBg : 'transparent', justifyContent: 'center' }}>
                <Text style={{ fontSize: 12.5, fontFamily: 'Roobert-Medium', color: on ? c.fg : c.muted }}>{f.label}</Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: insets.bottom + 40 }}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={query.isRefetching && !query.isFetchingNextPage} onRefresh={() => query.refetch()} tintColor={c.muted} />}
      >
        {query.isLoading ? (
          <View style={{ padding: 16 }}><SkeletonList count={6} isDark={isDark} avatar={false} /></View>
        ) : query.isError ? (
          <View style={{ padding: 20, gap: 10 }}>
            <Text style={{ fontSize: 13.5, color: '#ef4444' }}>{(query.error as Error)?.message || 'Failed to load audit events'}</Text>
            <TouchableOpacity onPress={() => query.refetch()} style={{ alignSelf: 'flex-start', paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, borderWidth: 1, borderColor: c.border }}><Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: c.fg }}>Retry</Text></TouchableOpacity>
          </View>
        ) : events.length === 0 ? (
          <View style={{ paddingVertical: 48, alignItems: 'center', gap: 4 }}>
            <Text style={{ fontSize: 14, fontFamily: 'Roobert-Medium', color: c.fg }}>No events match this filter</Text>
            <Text style={{ fontSize: 12.5, color: c.muted }}>Try a broader filter or check back later.</Text>
          </View>
        ) : (
          <>
            {events.map((e) => (
              <AuditRow key={e.event_id} event={e} actorEmail={e.actor_user_id ? emailByUserId.get(e.actor_user_id) ?? null : null} isSelf={!!user?.id && e.actor_user_id === user.id} isDark={isDark} border={c.border} />
            ))}
            {query.hasNextPage && (
              <View style={{ alignItems: 'center', paddingVertical: 14 }}>
                <TouchableOpacity onPress={() => query.fetchNextPage()} disabled={query.isFetchingNextPage} activeOpacity={0.7} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 16, height: 36, borderRadius: 9999, borderWidth: 1, borderColor: c.border }}>
                  {query.isFetchingNextPage && <ActivityIndicator size="small" color={c.muted} />}
                  <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: c.fg }}>Load more</Text>
                </TouchableOpacity>
              </View>
            )}
          </>
        )}
      </ScrollView>
    </View>
  );
}

function AuditRow({ event, actorEmail, isSelf, isDark, border }: { event: AuditEvent; actorEmail: string | null; isSelf: boolean; isDark: boolean; border: string }) {
  const c = accountColors(isDark);
  const [expanded, setExpanded] = useState(false);
  const hasDiff = event.before !== null || event.after !== null;
  const human = humanizeAuditAction(event.action);
  const occurred = new Date(event.occurred_at);
  const resourcePill = formatResourcePill(event.resource_type, event.resource_id);
  // Prefer a name (email), then "you", then a short friendly id — never the raw UUID.
  const actorLabel = actorEmail ?? (isSelf ? 'you' : event.actor_user_id ? `user ${event.actor_user_id.slice(0, 8)}` : 'system');
  const canExpand = hasDiff || event.action !== human.title;

  return (
    <View style={{ borderBottomWidth: 1, borderBottomColor: border }}>
      <TouchableOpacity onPress={() => canExpand && setExpanded((v) => !v)} disabled={!canExpand} activeOpacity={canExpand ? 0.6 : 1} style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8, paddingHorizontal: 16, paddingVertical: 12 }}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
            <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: KIND_DOT_COLOR[human.kind] }} />
            <Text style={{ fontSize: 12.5, lineHeight: 16, fontFamily: 'Roobert-Medium', color: c.fg }}>{human.title}</Text>
            {human.detail && <View style={{ paddingHorizontal: 5, paddingVertical: 1, borderRadius: 5, backgroundColor: c.avatarBg }}><Text style={{ fontSize: 10, fontFamily: MONO, color: c.fg }}>{human.detail}</Text></View>}
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 2, marginLeft: 13, flexWrap: 'wrap' }}>
            <Text style={{ fontSize: 10.5, color: c.muted }}>by <Text style={{ color: c.fg }}>{actorLabel}</Text></Text>
            <Text style={{ fontSize: 10.5, color: c.muted }}>· {relative(occurred)}</Text>
            {resourcePill && <View style={{ paddingHorizontal: 5, paddingVertical: 1, borderRadius: 5, borderWidth: 1, borderColor: border }}><Text style={{ fontSize: 9.5, color: c.muted, textTransform: 'capitalize' }}>{resourcePill}</Text></View>}
            {event.ip && <Text style={{ fontSize: 9.5, fontFamily: MONO, color: c.muted }}>{event.ip}</Text>}
          </View>
        </View>
        {canExpand && (expanded ? <ChevronDown size={15} color={c.muted} style={{ marginTop: 2 }} /> : <ChevronRight size={15} color={c.muted} style={{ marginTop: 2 }} />)}
      </TouchableOpacity>
      {expanded && canExpand && (
        <View style={{ paddingHorizontal: 16, paddingBottom: 14, gap: 12, backgroundColor: isDark ? 'rgba(255,255,255,0.02)' : 'rgba(0,0,0,0.015)' }}>
          <View style={{ gap: 4, paddingTop: 12 }}>
            <Text style={{ fontSize: 10, fontFamily: 'Roobert-Medium', color: c.muted, textTransform: 'uppercase', letterSpacing: 0.5 }}>Raw request</Text>
            <View style={{ borderRadius: 8, borderWidth: 1, borderColor: border, padding: 8 }}><Text style={{ fontSize: 11, fontFamily: MONO, color: c.fg }}>{event.action}</Text></View>
          </View>
          <Text style={{ fontSize: 11, color: c.muted }}>Occurred {occurred.toISOString()} · id {event.event_id}</Text>
          {hasDiff && (
            <View style={{ gap: 10 }}>
              <DiffPane label="Before" data={event.before} isDark={isDark} border={border} />
              <DiffPane label="After" data={event.after} isDark={isDark} border={border} />
            </View>
          )}
        </View>
      )}
    </View>
  );
}

function DiffPane({ label, data, isDark, border }: { label: string; data: Record<string, unknown> | null; isDark: boolean; border: string }) {
  const c = accountColors(isDark);
  return (
    <View>
      <Text style={{ fontSize: 10, fontFamily: 'Roobert-Medium', color: c.muted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>{label}</Text>
      <ScrollView style={{ maxHeight: 160, borderRadius: 8, borderWidth: 1, borderColor: border }} contentContainerStyle={{ padding: 8 }} showsVerticalScrollIndicator={false}>
        <Text style={{ fontSize: 11, lineHeight: 16, fontFamily: MONO, color: data === null ? c.muted : c.fg }}>{data === null ? 'None' : JSON.stringify(data, null, 2)}</Text>
      </ScrollView>
    </View>
  );
}
