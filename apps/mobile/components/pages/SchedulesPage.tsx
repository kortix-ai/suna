/**
 * SchedulesPage — cron triggers (web parity: triggers-view, type='cron').
 * A schedule fires an agent with a prompt on a recurring cron or a one-off
 * instant. List + create sheet (preset / custom cron / run-once) + detail sheet
 * (fire now, pause, delete, edit prompt).
 *
 * Mobile branding: PageHeader + PageContent chrome, bottom sheets, design tokens.
 *
 * Each control follows the leaves its trigger route asserts (KRTX-1720), from
 * one `useCans` probe read through the SDK's `triggerControlsFrom` (the same
 * mapping web's Triggers and Agent pages use): + on project.write +
 * project.trigger.create, Fire now on project.trigger.fire, Pause/Resume and
 * every edit (prompt, agent, model) on project.write + project.trigger.update,
 * Delete on project.write + project.trigger.delete. An unresolved probe shows
 * none of them.
 */

import React, { useMemo, useState } from 'react';
import { View } from 'react-native';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BottomSheetModal } from '@gorhom/bottom-sheet';
import { TRIGGER_CONTROL_ACTIONS, triggerControlsFrom } from '@kortix/sdk';
import { useCans } from '@kortix/sdk/react';
import { CaretRightIcon as ChevronRight, WarningIcon as TriangleAlert } from '@/lib/icons';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { PageHeader } from '@/components/kortix/page-header';
import { PageContent } from '@/components/kortix/page-content';
import { SearchListHeader } from '@/components/kortix/search-list-header';
import { PageList, StatusDot } from '@/components/kortix/page-list';
import { THEME, withAlpha } from '@/lib/utils/theme';
import { useProjectTriggers } from '@/lib/projects/hooks';
import type { ProjectTrigger } from '@/lib/projects/projects-client';
import { describeCron, relativeTime } from '@/lib/projects/triggers-format';
import { haptics } from '@/lib/haptics';
import { KortixBottomSheetModal } from '@/components/kortix/sheet';
import { SettingsGroupItem, SettingsRow } from '@/components/kortix/settings-list';
import { ScheduleCreateSheet, ScheduleDetailSheet } from '@/components/schedules/ScheduleSheets';

interface PageTabLike {
  id: string;
  label: string;
}

interface SchedulesPageProps {
  page: PageTabLike;
  projectId: string;
  /** Pushed as a sub-page of project Settings: Go back in place of the hamburger. */
  onBack?: () => void;
  onOpenDrawer?: () => void;
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export function SchedulesPage({
  page,
  projectId,
  onBack,
  onOpenDrawer,
}: SchedulesPageProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const insets = useSafeAreaInsets();
  const [search, setSearch] = useState('');
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const addSheetRef = React.useRef<BottomSheetModal>(null);
  const detailSheetRef = React.useRef<BottomSheetModal>(null);

  const { data, isLoading, isError, error, refetch } = useProjectTriggers(projectId);
  const controls = triggerControlsFrom(useCans({ projectId }, TRIGGER_CONTROL_ACTIONS));

  const bgColor = isDark ? THEME.dark.background : THEME.light.background;
  const fg = isDark ? THEME.dark.foreground : THEME.light.foreground;
  const muted = isDark ? THEME.dark.mutedForeground : THEME.light.mutedForeground;
  const border = withAlpha(fg, 0.08);

  const forbidden = isError && /403|forbidden/i.test((error as Error)?.message ?? '');
  const all = useMemo(() => (data?.triggers ?? []).filter((t) => t.type === 'cron'), [data]);
  const errors = data?.errors ?? [];
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? all.filter((t) => (t.name || t.slug).toLowerCase().includes(q)) : all;
  }, [all, search]);
  const selected = useMemo(() => all.find((t) => t.slug === selectedSlug) ?? null, [all, selectedSlug]);

  const openRow = (slug: string) => {
    haptics.tap();
    setSelectedSlug(slug);
    detailSheetRef.current?.present();
  };

  return (
    <View style={{ flex: 1, backgroundColor: bgColor }}>
      <PageHeader
        title={page.label}
        onBack={onBack}
        onOpenDrawer={onBack ? undefined : onOpenDrawer}
        onAdd={controls.canCreate ? () => { haptics.tap(); addSheetRef.current?.present(); } : undefined}
        addLabel="New schedule"
      />

      <PageContent>
        {errors.length > 0 && (
          <View style={{ marginHorizontal: 16, marginTop: 12, padding: 12, borderRadius: 12, backgroundColor: withAlpha(THEME.accent.orange, 0.08) }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <Icon as={TriangleAlert} size={15} color={THEME.accent.orange} />
              <Text style={{ fontSize: 12.5, fontFamily: 'Roobert-Medium', color: THEME.accent.orange }}>Some triggers couldn't be parsed</Text>
            </View>
            {errors.map((e) => (
              <Text key={e.slug + e.path} style={{ fontSize: 12, color: THEME.accent.orange, marginTop: 2 }}>{e.path} — {e.error}</Text>
            ))}
          </View>
        )}

        <SearchListHeader value={search} onChangeText={setSearch} placeholder="Search schedules" />

        <PageList<ProjectTrigger>
          isLoading={isLoading}
          errorMessage={!forbidden && isError && all.length === 0 ? ((error as Error)?.message ?? 'Unable to load schedules') : null}
          onRetry={() => void refetch()}
          onRefresh={() => refetch()}
          emptyLabel={
            forbidden
              ? "You don't have access to this project's schedules"
              : filtered.length === 0
                ? all.length === 0 ? 'No schedules yet' : 'No matching schedules'
                : null
          }
          // Settings rows in a group (Jay, 2026-09-22), the Agents list's
          // layout; virtualised, one `SettingsGroupItem` per row (COR-155).
          header={<View className="h-1" />}
          data={filtered}
          keyExtractor={(t) => t.slug}
          renderItem={(t, index) => (
            <View className="px-4">
              <SettingsGroupItem index={index} count={filtered.length}>
                <SettingsRow
                  label={t.name || describeCron(t.cron)}
                  description={`${t.run_at ? 'One-off' : describeCron(t.cron)} · ${relativeTime(t.last_fired_at)} · ${t.agent || 'default'}`}
                  onPress={() => openRow(t.slug)}
                  right={
                    <View className="flex-row items-center gap-3">
                      <StatusDot on={!!t.enabled} label={t.enabled ? 'Active' : 'Paused'} />
                      <Icon as={ChevronRight} size={16} className="text-muted-foreground/70" />
                    </View>
                  }
                />
              </SettingsGroupItem>
            </View>
          )}
        />
      </PageContent>

      <KortixBottomSheetModal
        ref={addSheetRef}
        snapPoints={['100%']}
        enableDynamicSizing={false}
        keyboardBehavior="interactive"
        keyboardBlurBehavior="restore"
      >
        <ScheduleCreateSheet projectId={projectId} onClose={() => addSheetRef.current?.dismiss()} isDark={isDark} />
      </KortixBottomSheetModal>

      <KortixBottomSheetModal
        ref={detailSheetRef}
        snapPoints={['100%']}
        enableDynamicSizing={false}
        onDismiss={() => setSelectedSlug(null)}
        keyboardBehavior="interactive"
        keyboardBlurBehavior="restore"
      >
        {selected ? (
          <ScheduleDetailSheet
            projectId={projectId}
            trigger={selected}
            controls={controls}
            onClose={() => detailSheetRef.current?.dismiss()}
            isDark={isDark}
          />
        ) : (
          <View style={{ height: 1 }} />
        )}
      </KortixBottomSheetModal>
    </View>
  );
}
