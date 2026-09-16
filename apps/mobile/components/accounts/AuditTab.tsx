/**
 * Account → Audit (web parity: iam/audit-tab). Cursor-paginated audit log.
 * Top: a horizontal filter toggle. Groups: Export · Events (tap an event for
 * its details) with Load more at the end.
 */

import React, { useMemo, useState } from 'react';
import { Alert, RefreshControl, ScrollView, View } from 'react-native';
import { useInfiniteQuery } from '@tanstack/react-query';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { WarningCircleIcon as AlertCircle, CaretDoubleDownIcon as ChevronsDown, DownloadIcon as Download, ArrowClockwiseIcon as RotateCw } from '@/lib/icons';

import { Text } from '@/components/ui/text';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { KortixLoader } from '@/components/kortix/kortix-loader';
import { SettingsGroup, SettingsPage, SettingsRow } from '@/components/kortix/settings-list';
import { haptics } from '@/lib/haptics';
import { API_URL, getAuthToken } from '@/api/config';
import { useAuthContext } from '@/contexts';
import { useAccountMembers } from '@/lib/accounts/hooks';
import { listAuditEvents } from '@/lib/accounts/accounts-client';
import type { AccountDetail, AuditEvent } from '@/lib/accounts/accounts-client';
import { humanizeAuditAction, formatResourcePill, KIND_DOT_COLOR } from '@/lib/accounts/audit-display';

interface QuickFilter { label: string; action: string | null; daysBack: number | null }
const QUICK_FILTERS: QuickFilter[] = [
  { label: 'All', action: null, daysBack: null },
  { label: 'IAM', action: 'iam.', daysBack: null },
  { label: 'Groups', action: 'iam.group', daysBack: null },
  { label: 'Project access', action: 'iam.project.group', daysBack: null },
  { label: 'Super-admin', action: 'iam.member.super_admin', daysBack: null },
  { label: '24h', action: null, daysBack: 1 },
  { label: '7d', action: null, daysBack: 7 },
  { label: '30d', action: null, daysBack: 30 },
];

const daysAgoIso = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
/** Pretty JSON for the details alert, capped so a large diff stays readable. */
const preview = (data: Record<string, unknown> | null) => {
  if (data === null) return 'none';
  const json = JSON.stringify(data, null, 2);
  return json.length > 400 ? `${json.slice(0, 400)}…` : json;
};

function relative(d: Date): string {
  const minutes = Math.floor((Date.now() - d.getTime()) / 60_000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return d.toLocaleDateString();
}

export function AuditTab({ account }: { account: AccountDetail; isDark?: boolean }) {
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
        if (!token) { Alert.alert('Sign in to export'); return; }
        const params = new URLSearchParams({ format });
        if (active.action) params.set('action', active.action);
        if (active.daysBack) params.set('since', daysAgoIso(active.daysBack));
        const res = await fetch(`${API_URL}/accounts/${accountId}/audit/export?${params.toString()}`, { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) { Alert.alert('Export failed', `The server returned ${res.status}.`); return; }
        const text = await res.text();
        const filename = `audit-${new Date().toISOString().slice(0, 10)}.${format}`;
        const target = `${FileSystem.cacheDirectory}${filename}`;
        await FileSystem.writeAsStringAsync(target, text);
        if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(target);
      } catch (e: any) {
        Alert.alert('Export failed', e?.message || 'Could not export the audit log.');
      } finally {
        setExporting(false);
      }
    })();
  };

  const openDetails = (event: AuditEvent) => {
    haptics.selection();
    const human = humanizeAuditAction(event.action);
    const actorEmail = event.actor_user_id ? emailByUserId.get(event.actor_user_id) ?? null : null;
    const isSelf = !!user?.id && event.actor_user_id === user.id;
    const actor = actorEmail ?? (isSelf ? 'you' : event.actor_user_id ? `user ${event.actor_user_id.slice(0, 8)}` : 'system');
    const resource = formatResourcePill(event.resource_type, event.resource_id);
    const hasDiff = event.before !== null || event.after !== null;
    const lines = [
      human.detail ? `${human.title} (${human.detail})` : null,
      `By ${actor}`,
      new Date(event.occurred_at).toLocaleString(),
      resource,
      event.ip ? `IP ${event.ip}` : null,
      event.action,
      hasDiff ? `\nBefore\n${preview(event.before)}\n\nAfter\n${preview(event.after)}` : null,
    ].filter(Boolean);
    Alert.alert(human.title, lines.join('\n'), [{ text: 'OK', style: 'cancel' }]);
  };

  const filters = (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} className="-mx-5" contentContainerClassName="px-5">
      <ToggleGroup
        type="single"
        value={String(filterIndex)}
        className="overflow-hidden rounded-md border border-border"
        onValueChange={(next) => {
          if (!next) return;
          haptics.selection();
          setFilterIndex(Number(next));
        }}>
        {QUICK_FILTERS.map((f, i) => (
          <ToggleGroupItem
            key={f.label}
            value={String(i)}
            size="sm"
            aria-label={f.label}
            isFirst={i === 0}
            isLast={i === QUICK_FILTERS.length - 1}>
            <Text>{f.label}</Text>
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </ScrollView>
  );

  return (
    <SettingsPage
      header={filters}
      refreshControl={
        <RefreshControl refreshing={query.isRefetching && !query.isFetchingNextPage} onRefresh={() => query.refetch()} />
      }>
      <SettingsGroup>
        <SettingsRow
          icon={Download}
          label="Export"
          value={exporting ? 'Exporting…' : undefined}
          onPress={
            exporting
              ? undefined
              : () => {
                  haptics.tap();
                  Alert.alert('Export audit log', 'Choose a format', [
                    { text: 'CSV', onPress: () => exportEvents('csv') },
                    { text: 'JSONL', onPress: () => exportEvents('jsonl') },
                    { text: 'Cancel', style: 'cancel' },
                  ]);
                }
          }
        />
      </SettingsGroup>

      {query.isLoading ? (
        <View className="items-center py-12">
          <KortixLoader />
        </View>
      ) : query.isError ? (
        <SettingsGroup>
          <SettingsRow icon={AlertCircle} label="Couldn't load audit events" destructive />
          <SettingsRow icon={RotateCw} label="Try again" onPress={() => { haptics.tap(); query.refetch(); }} />
        </SettingsGroup>
      ) : events.length === 0 ? (
        <Text variant="muted" className="py-10 text-center">
          No events match this filter.
        </Text>
      ) : (
        <SettingsGroup title="Events">
          {events.map((e) => {
            const human = humanizeAuditAction(e.action);
            return (
              <SettingsRow
                key={e.event_id}
                leading={
                  <View
                    className="h-2 w-2 rounded-full"
                    style={{ backgroundColor: KIND_DOT_COLOR[human.kind] }}
                  />
                }
                label={human.title}
                value={relative(new Date(e.occurred_at))}
                right={null}
                onPress={() => openDetails(e)}
              />
            );
          })}
          {query.hasNextPage && (
            <SettingsRow
              icon={ChevronsDown}
              label={query.isFetchingNextPage ? 'Loading…' : 'Load more'}
              right={null}
              onPress={query.isFetchingNextPage ? undefined : () => { haptics.tap(); query.fetchNextPage(); }}
            />
          )}
        </SettingsGroup>
      )}
    </SettingsPage>
  );
}
