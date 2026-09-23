/**
 * SchedulesPage — cron triggers (web parity: triggers-view, type='cron').
 * A schedule fires an agent with a prompt on a recurring cron or a one-off
 * instant. List + create sheet (preset / custom cron / run-once) + detail sheet
 * (fire now, pause, delete, edit prompt).
 *
 * Mobile branding: PageHeader + PageContent chrome, bottom sheets, design tokens.
 */

import React, { useMemo, useState } from 'react';
import {
  View,
  Pressable,
  ScrollView,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BottomSheetModal, BottomSheetScrollView, BottomSheetTextInput } from '@gorhom/bottom-sheet';
import {
  TimerIcon as Timer,
  ClockIcon as Clock,
  PlayIcon as Play,
  PauseIcon as Pause,
  TrashIcon as Trash2,
  XIcon as X,
  CaretRightIcon as ChevronRight,
  WarningIcon as TriangleAlert,
  CheckIcon as Check,
} from '@/lib/icons';
import { PressableSurface } from '@/components/kortix/pressable-surface';
import { Text } from '@/components/ui/text';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { PageHeader } from '@/components/kortix/page-header';
import { PageContent } from '@/components/kortix/page-content';
import { SearchListHeader } from '@/components/kortix/search-list-header';
import { PageList, StatusDot } from '@/components/kortix/page-list';
import { PinnedBar, usePinnedBarInset } from '@/components/kortix/pinned-bar';
import { useThemeColors } from '@/lib/theme-colors';
import { THEME, withAlpha } from '@/lib/utils/theme';
import { AgentPickerField, ModelPickerField } from './TriggerAgentModelFields';
import { PromptEditView, PromptPreview } from './TriggerPromptField';
import { POP_IN, PUSH_IN } from '@/components/kortix/sheet-push';
import Animated from 'react-native-reanimated';
import {
  useProjectTriggers,
  useCreateProjectTrigger,
  useUpdateProjectTrigger,
  useDeleteProjectTrigger,
  useFireProjectTrigger,
} from '@/lib/projects/hooks';
import type { ProjectTrigger } from '@/lib/projects/projects-client';
import {
  CRON_PRESETS,
  DEFAULT_CRON,
  TIMEZONES,
  RUN_AT_PRESETS,
  describeCron,
  describeRunAt,
  relativeTime,
} from '@/lib/projects/triggers-format';
import { haptics } from '@/lib/haptics';
import { KortixBottomSheetModal, SheetTitleRow, useSheetBackground } from '@/components/kortix/sheet';
import { SettingsGroup, SettingsRow } from '@/components/kortix/settings-list';

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
  onOpenRightDrawer?: () => void;
  isDrawerOpen?: boolean;
  isRightDrawerOpen?: boolean;
}

const MONO = 'Menlo';
/** The detail sheet's pinned action row: `Button size="lg"`, 44pt. */
const ACTION_BAR_HEIGHT = 44;

// ─── Create schedule ──────────────────────────────────────────────────────────

function ScheduleCreateSheet({
  projectId,
  onClose,
  isDark,
}: {
  projectId: string;
  onClose: () => void;
  isDark: boolean;
}) {
  const theme = useThemeColors();
  const insets = useSafeAreaInsets();
  const create = useCreateProjectTrigger(projectId);

  const [mode, setMode] = useState<'recurring' | 'once'>('recurring');
  const [cron, setCron] = useState(DEFAULT_CRON);
  const [runAt, setRunAt] = useState<string | null>(null);
  const [timezone, setTimezone] = useState('UTC');
  const [tzOpen, setTzOpen] = useState(false);
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [agent, setAgent] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const fg = isDark ? THEME.dark.foreground : THEME.light.foreground;
  const muted = isDark ? THEME.dark.mutedForeground : THEME.light.mutedForeground;
  const destructiveColor = isDark ? THEME.dark.destructive : THEME.light.destructive;
  const border = withAlpha(fg, isDark ? 0.1 : 0.12);
  const inputBg = withAlpha(fg, isDark ? 0.05 : 0.03);
  const input = { height: 44, borderRadius: 11, borderWidth: 1, borderColor: border, backgroundColor: inputBg, paddingHorizontal: 12, fontSize: 14, color: fg, fontFamily: 'Roobert' as const };

  const canSave =
    name.trim().length > 0 &&
    prompt.trim().length > 0 &&
    (mode === 'recurring' ? cron.trim().length > 0 : !!runAt) &&
    !create.isPending;

  const handleSave = () => {
    if (!canSave) return;
    setErr(null);
    haptics.tap();
    create.mutate(
      {
        name: name.trim(),
        type: 'cron',
        prompt_template: prompt,
        ...(agent ? { agent } : {}),
        ...(model ? { model } : {}),
        enabled: true,
        ...(mode === 'recurring' ? { cron: cron.trim(), timezone } : { run_at: runAt!, timezone }),
      },
      {
        onSuccess: () => { haptics.success(); onClose(); },
        onError: (e: any) => setErr(e?.message || 'Could not create schedule.'),
      },
    );
  };

  return (
    <View style={{ flex: 1 }}>
      <SheetTitleRow title="New schedule" onClose={() => { haptics.tap(); onClose(); }} />

      <BottomSheetScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16 }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        {/* mode */}
        <View style={{ flexDirection: 'row', backgroundColor: inputBg, borderRadius: 9999, padding: 3, marginBottom: 16 }}>
          {([{ k: 'recurring', l: 'Recurring' }, { k: 'once', l: 'Run once' }] as const).map((o) => {
            const on = mode === o.k;
            return (
              <Pressable key={o.k} onPress={() => { haptics.selection(); setMode(o.k); }} style={{ flex: 1, paddingVertical: 8, borderRadius: 9999, alignItems: 'center', backgroundColor: on ? (isDark ? withAlpha(fg, 0.12) : THEME.light.background) : 'transparent' }}>
                <Text style={{ fontSize: 13, fontFamily: on ? 'Roobert-Medium' : 'Roobert', color: on ? fg : muted }}>{o.l}</Text>
              </Pressable>
            );
          })}
        </View>

        {mode === 'recurring' ? (
          <>
            <Text style={{ fontSize: 12, fontFamily: 'Roobert-Medium', color: muted, marginBottom: 8 }}>Schedule</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
              {CRON_PRESETS.map((p) => {
                const on = cron === p.cron;
                return (
                  <Pressable key={p.cron} onPress={() => { haptics.selection(); setCron(p.cron); }} style={{ paddingHorizontal: 12, paddingVertical: 8, borderRadius: 9999, borderWidth: 1.5, borderColor: on ? theme.primary : border, backgroundColor: on ? theme.primaryLight : 'transparent' }}>
                    <Text style={{ fontSize: 12.5, fontFamily: 'Roobert-Medium', color: on ? theme.primary : muted }}>{p.label}</Text>
                  </Pressable>
                );
              })}
            </View>
            <Text style={{ fontSize: 12, fontFamily: 'Roobert-Medium', color: muted, marginBottom: 6 }}>Custom cron</Text>
            <BottomSheetTextInput value={cron} onChangeText={setCron} placeholder="0 0 9 * * *" placeholderTextColor={muted} autoCapitalize="none" autoCorrect={false} style={[input, { fontFamily: MONO }]} />
            <Text style={{ fontSize: 11.5, color: muted, marginTop: 6 }}>6 fields: sec min hour day month weekday</Text>

            {/* timezone */}
            <Text style={{ fontSize: 12, fontFamily: 'Roobert-Medium', color: muted, marginTop: 16, marginBottom: 6 }}>Timezone</Text>
            <Pressable onPress={() => { haptics.tap(); setTzOpen((v) => !v); }} style={{ ...input, flexDirection: 'row', alignItems: 'center' }}>
              <Text style={{ flex: 1, fontSize: 14, color: fg, fontFamily: MONO }}>{timezone}</Text>
              <Icon as={ChevronRight} size={16} color={muted} style={{ transform: [{ rotate: tzOpen ? '90deg' : '0deg' }] }} />
            </Pressable>
            {tzOpen && (
              <View style={{ marginTop: 8, borderRadius: 11, borderWidth: 1, borderColor: border, overflow: 'hidden' }}>
                {TIMEZONES.map((tz, i) => (
                  <Pressable key={tz} onPress={() => { haptics.selection(); setTimezone(tz); setTzOpen(false); }} style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 11, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: border }}>
                    <Text style={{ flex: 1, fontSize: 13.5, fontFamily: MONO, color: fg }}>{tz}</Text>
                    {timezone === tz && <Icon as={Check} size={15} color={theme.primary} />}
                  </Pressable>
                ))}
              </View>
            )}
          </>
        ) : (
          <>
            <Text style={{ fontSize: 12, fontFamily: 'Roobert-Medium', color: muted, marginBottom: 8 }}>Run once</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
              {RUN_AT_PRESETS.map((p) => (
                <Pressable key={p.label} onPress={() => { haptics.selection(); setRunAt(new Date(Date.now() + p.offset).toISOString()); }} style={{ paddingHorizontal: 12, paddingVertical: 8, borderRadius: 9999, borderWidth: 1.5, borderColor: border }}>
                  <Text style={{ fontSize: 12.5, fontFamily: 'Roobert-Medium', color: muted }}>{p.label}</Text>
                </Pressable>
              ))}
            </View>
            <Text style={{ fontSize: 12.5, color: runAt ? theme.primary : muted }}>
              {runAt ? describeRunAt(runAt) : 'Pick when it should fire.'}
            </Text>
          </>
        )}

        <Text style={{ fontSize: 12, fontFamily: 'Roobert-Medium', color: muted, marginTop: 18, marginBottom: 6 }}>Name</Text>
        <BottomSheetTextInput value={name} onChangeText={setName} placeholder="Daily digest" placeholderTextColor={muted} maxLength={64} style={input} />

        <Text style={{ fontSize: 12, fontFamily: 'Roobert-Medium', color: muted, marginTop: 14, marginBottom: 6 }}>Prompt</Text>
        <BottomSheetTextInput value={prompt} onChangeText={setPrompt} placeholder="What should the agent do when this fires?" placeholderTextColor={muted} multiline style={[input, { height: 96, paddingTop: 10, textAlignVertical: 'top' }]} />

        <AgentPickerField projectId={projectId} value={agent} onChange={setAgent} isDark={isDark} />
        <ModelPickerField projectId={projectId} value={model} onChange={setModel} isDark={isDark} />

        {err && (
          <View style={{ marginTop: 14, padding: 12, borderRadius: 11, backgroundColor: withAlpha(destructiveColor, 0.08), borderWidth: 1, borderColor: withAlpha(destructiveColor, 0.3) }}>
            <Text style={{ fontSize: 13, color: destructiveColor }}>{err}</Text>
          </View>
        )}
      </BottomSheetScrollView>

      <View style={{ padding: 16, paddingBottom: insets.bottom + 16, borderTopWidth: 1, borderTopColor: withAlpha(fg, 0.08) }}>
        <Button size="lg" onPress={handleSave} disabled={!canSave} className="rounded-full">
          {create.isPending && <ActivityIndicator size="small" color={theme.primaryForeground} />}
          <Text>Create schedule</Text>
        </Button>
      </View>
    </View>
  );
}

// ─── Schedule detail ──────────────────────────────────────────────────────────

function ScheduleDetailSheet({
  projectId,
  trigger,
  onClose,
  isDark,
}: {
  projectId: string;
  trigger: ProjectTrigger;
  onClose: () => void;
  isDark: boolean;
}) {
  const sheetBackground = useSheetBackground();
  const barInset = usePinnedBarInset(ACTION_BAR_HEIGHT);
  const fire = useFireProjectTrigger(projectId);
  const update = useUpdateProjectTrigger(projectId);
  const del = useDeleteProjectTrigger(projectId);
  const [editingPrompt, setEditingPrompt] = useState(false);
  // The detail slides back in only after the editor was open, never on first open.
  const [returning, setReturning] = useState(false);
  const closePromptEditor = () => {
    setReturning(true);
    setEditingPrompt(false);
  };

  const fg = isDark ? THEME.dark.foreground : THEME.light.foreground;
  const muted = isDark ? THEME.dark.mutedForeground : THEME.light.mutedForeground;

  const oneOff = !!trigger.run_at;

  const handleFire = () => {
    haptics.tap();
    fire.mutate(trigger.slug, {
      onSuccess: (res) => Alert.alert(
        res.status === 'failed' ? 'Failed to fire' : res.status === 'queued' ? 'Queued' : 'Fired',
        res.status === 'failed' ? (res.error || res.reason || 'Could not fire.') : 'The schedule was triggered.',
      ),
      onError: (e: any) => Alert.alert('Failed', e?.message || 'Could not fire.'),
    });
  };
  const togglePaused = () => {
    haptics.tap();
    update.mutate({ slug: trigger.slug, input: { enabled: !trigger.enabled } }, {
      onError: (e: any) => Alert.alert('Failed', e?.message || 'Could not update.'),
    });
  };
  const handleSavePrompt = (next: string) => {
    haptics.tap();
    update.mutate({ slug: trigger.slug, input: { prompt_template: next } }, {
      onSuccess: closePromptEditor,
      onError: (e: any) => Alert.alert('Failed', e?.message || 'Could not save prompt.'),
    });
  };
  const handleAgentChange = (agent: string) => {
    update.mutate({ slug: trigger.slug, input: { agent } }, {
      onError: (e: any) => Alert.alert('Failed', e?.message || 'Could not update agent.'),
    });
  };
  const handleModelChange = (model: string | null) => {
    update.mutate({ slug: trigger.slug, input: { model } }, {
      onError: (e: any) => Alert.alert('Failed', e?.message || 'Could not update model.'),
    });
  };
  const handleDelete = () => {
    Alert.alert('Remove schedule', `Remove "${trigger.name || trigger.slug}"? This stops future runs.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => {
        haptics.medium();
        del.mutate(trigger.slug, { onSuccess: onClose, onError: (e: any) => Alert.alert('Failed', e?.message || 'Could not remove.') });
      } },
    ]);
  };

  if (editingPrompt) {
    return (
      <Animated.View key="prompt" entering={PUSH_IN} style={{ flex: 1 }}>
        <PromptEditView
          value={trigger.prompt_template}
          placeholders="{{ message.text }} · {{ fired_at }}"
          saving={update.isPending}
          onSave={handleSavePrompt}
          onBack={closePromptEditor}
        />
      </Animated.View>
    );
  }

  return (
    <Animated.View key="detail" entering={returning ? POP_IN : undefined} style={{ flex: 1 }}>
      {/* No status badge and no slug here (Jay, 2026-09-22): the title names the
          schedule, and the pause button below says whether it runs. */}
      <SheetTitleRow title={trigger.name || trigger.slug} onClose={() => { haptics.tap(); onClose(); }} />

      <View style={{ flex: 1 }}>
      <BottomSheetScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 4, paddingBottom: barInset, gap: 16 }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled">
        <SettingsGroup>
          <SettingsRow label="Runs" value={oneOff ? describeRunAt(trigger.run_at) : describeCron(trigger.cron)} />
          {!oneOff && trigger.cron ? <SettingsRow label="Cron" value={trigger.cron} /> : null}
          {!oneOff && trigger.timezone ? <SettingsRow label="Time zone" value={trigger.timezone} /> : null}
        </SettingsGroup>

        <PromptPreview value={trigger.prompt_template} onEdit={() => setEditingPrompt(true)} />

        <AgentPickerField projectId={projectId} value={trigger.agent} onChange={handleAgentChange} flush />
        <ModelPickerField projectId={projectId} value={trigger.model} onChange={handleModelChange} flush />

        <SettingsGroup>
          <SettingsRow label="Last fired" value={relativeTime(trigger.last_fired_at)} />
          <SettingsRow label="Source" value={trigger.path} />
        </SettingsGroup>
      </BottomSheetScrollView>

      {/* Pinned action bar, floating over a fade of the sheet, the content
          scrolling under it — the agent and skill detail's fade (Jay,
          2026-09-22). Fire now · pause or resume · delete. */}
      <PinnedBar controlHeight={ACTION_BAR_HEIGHT} background={sheetBackground} className="gap-3 px-4">
        <Button size="lg" onPress={handleFire} disabled={fire.isPending} className="flex-1 rounded-full">
          <Icon as={Play} size={16} className="text-primary-foreground" />
          <Text>{fire.isPending ? 'Firing…' : 'Fire now'}</Text>
        </Button>
        <Button
          variant="secondary"
          size="lg"
          className="rounded-full"
          onPress={togglePaused}
          disabled={update.isPending}
          accessibilityLabel={trigger.enabled ? 'Pause schedule' : 'Resume schedule'}>
          <Icon as={trigger.enabled ? Pause : Play} size={16} className="text-foreground" />
          <Text>{trigger.enabled ? 'Pause' : 'Resume'}</Text>
        </Button>
        <Button
          variant="secondary"
          size="icon"
          className="rounded-full"
          onPress={handleDelete}
          disabled={del.isPending}
          accessibilityLabel="Delete schedule">
          <Icon as={Trash2} size={18} className="text-destructive" />
        </Button>
      </PinnedBar>
      </View>
    </Animated.View>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export function SchedulesPage({
  page,
  projectId,
  onBack,
  onOpenDrawer,
  onOpenRightDrawer,
  isDrawerOpen,
  isRightDrawerOpen,
}: SchedulesPageProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const insets = useSafeAreaInsets();
  const [search, setSearch] = useState('');
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const addSheetRef = React.useRef<BottomSheetModal>(null);
  const detailSheetRef = React.useRef<BottomSheetModal>(null);

  const { data, isLoading, isError, error, refetch } = useProjectTriggers(projectId);

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
        onOpenRightDrawer={onOpenRightDrawer}
        isDrawerOpen={isDrawerOpen}
        isRightDrawerOpen={isRightDrawerOpen}
        onAdd={() => { haptics.tap(); addSheetRef.current?.present(); }}
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

        <PageList
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
>
          {/* Settings rows in a group (Jay, 2026-09-22), the Agents list's layout. */}
          <View className="px-4 pt-1">
            <SettingsGroup>
              {filtered.map((t) => (
                <SettingsRow
                  key={t.slug}
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
              ))}
            </SettingsGroup>
          </View>
        </PageList>
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
          <ScheduleDetailSheet projectId={projectId} trigger={selected} onClose={() => detailSheetRef.current?.dismiss()} isDark={isDark} />
        ) : (
          <View style={{ height: 1 }} />
        )}
      </KortixBottomSheetModal>
    </View>
  );
}
