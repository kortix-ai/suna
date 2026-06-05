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
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  BottomSheetModal,
  BottomSheetBackdrop,
  BottomSheetScrollView,
  BottomSheetTextInput,
} from '@gorhom/bottom-sheet';
import {
  Timer,
  Clock,
  Play,
  Pause,
  Trash2,
  X,
  ChevronRight,
  TriangleAlert,
  Check,
} from 'lucide-react-native';
import { Text } from '@/components/ui/text';
import { PageHeader } from '@/components/ui/page-header';
import { PageContent } from '@/components/ui/page-content';
import { SearchListHeader } from '@/components/ui/search-list-header';
import { useThemeColors, getSheetBg } from '@/lib/theme-colors';
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

interface PageTabLike {
  id: string;
  label: string;
  icon: string;
}

interface SchedulesPageProps {
  page: PageTabLike;
  projectId: string;
  onOpenDrawer?: () => void;
  onOpenRightDrawer?: () => void;
  isDrawerOpen?: boolean;
  isRightDrawerOpen?: boolean;
}

const MONO = 'Menlo';

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
  const [agent, setAgent] = useState('default');
  const [err, setErr] = useState<string | null>(null);

  const fg = isDark ? '#F8F8F8' : '#121215';
  const muted = isDark ? '#9b9b9b' : '#6e6e6e';
  const border = isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.12)';
  const inputBg = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.03)';
  const closeBg = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)';
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
        agent: agent.trim() || 'default',
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
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingTop: 4, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)' }}>
        <Text style={{ flex: 1, fontSize: 18, fontFamily: 'Roobert-Medium', color: fg }}>New schedule</Text>
        <TouchableOpacity onPress={() => { haptics.tap(); onClose(); }} hitSlop={8} style={{ width: 30, height: 30, borderRadius: 15, backgroundColor: closeBg, alignItems: 'center', justifyContent: 'center' }}>
          <X size={17} color={muted} />
        </TouchableOpacity>
      </View>

      <BottomSheetScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16 }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        {/* mode */}
        <View style={{ flexDirection: 'row', backgroundColor: inputBg, borderRadius: 9999, padding: 3, marginBottom: 16 }}>
          {([{ k: 'recurring', l: 'Recurring' }, { k: 'once', l: 'Run once' }] as const).map((o) => {
            const on = mode === o.k;
            return (
              <TouchableOpacity key={o.k} onPress={() => { haptics.selection(); setMode(o.k); }} activeOpacity={0.7} style={{ flex: 1, paddingVertical: 8, borderRadius: 9999, alignItems: 'center', backgroundColor: on ? (isDark ? 'rgba(255,255,255,0.12)' : '#FFFFFF') : 'transparent' }}>
                <Text style={{ fontSize: 13, fontFamily: on ? 'Roobert-Medium' : 'Roobert', color: on ? fg : muted }}>{o.l}</Text>
              </TouchableOpacity>
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
                  <TouchableOpacity key={p.cron} onPress={() => { haptics.selection(); setCron(p.cron); }} activeOpacity={0.7} style={{ paddingHorizontal: 12, paddingVertical: 8, borderRadius: 9999, borderWidth: 1.5, borderColor: on ? theme.primary : border, backgroundColor: on ? theme.primaryLight : 'transparent' }}>
                    <Text style={{ fontSize: 12.5, fontFamily: 'Roobert-Medium', color: on ? theme.primary : muted }}>{p.label}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
            <Text style={{ fontSize: 12, fontFamily: 'Roobert-Medium', color: muted, marginBottom: 6 }}>Custom cron</Text>
            <BottomSheetTextInput value={cron} onChangeText={setCron} placeholder="0 0 9 * * *" placeholderTextColor={muted} autoCapitalize="none" autoCorrect={false} style={[input, { fontFamily: MONO }]} />
            <Text style={{ fontSize: 11.5, color: muted, marginTop: 6 }}>6 fields: sec min hour day month weekday</Text>

            {/* timezone */}
            <Text style={{ fontSize: 12, fontFamily: 'Roobert-Medium', color: muted, marginTop: 16, marginBottom: 6 }}>Timezone</Text>
            <TouchableOpacity onPress={() => { haptics.tap(); setTzOpen((v) => !v); }} activeOpacity={0.7} style={{ ...input, flexDirection: 'row', alignItems: 'center' }}>
              <Text style={{ flex: 1, fontSize: 14, color: fg, fontFamily: MONO }}>{timezone}</Text>
              <ChevronRight size={16} color={muted} style={{ transform: [{ rotate: tzOpen ? '90deg' : '0deg' }] }} />
            </TouchableOpacity>
            {tzOpen && (
              <View style={{ marginTop: 8, borderRadius: 11, borderWidth: 1, borderColor: border, overflow: 'hidden' }}>
                {TIMEZONES.map((tz, i) => (
                  <TouchableOpacity key={tz} onPress={() => { haptics.selection(); setTimezone(tz); setTzOpen(false); }} activeOpacity={0.6} style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 11, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: border }}>
                    <Text style={{ flex: 1, fontSize: 13.5, fontFamily: MONO, color: fg }}>{tz}</Text>
                    {timezone === tz && <Check size={15} color={theme.primary} strokeWidth={3} />}
                  </TouchableOpacity>
                ))}
              </View>
            )}
          </>
        ) : (
          <>
            <Text style={{ fontSize: 12, fontFamily: 'Roobert-Medium', color: muted, marginBottom: 8 }}>Run once</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
              {RUN_AT_PRESETS.map((p) => (
                <TouchableOpacity key={p.label} onPress={() => { haptics.selection(); setRunAt(new Date(Date.now() + p.offset).toISOString()); }} activeOpacity={0.7} style={{ paddingHorizontal: 12, paddingVertical: 8, borderRadius: 9999, borderWidth: 1.5, borderColor: border }}>
                  <Text style={{ fontSize: 12.5, fontFamily: 'Roobert-Medium', color: muted }}>{p.label}</Text>
                </TouchableOpacity>
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

        <Text style={{ fontSize: 12, fontFamily: 'Roobert-Medium', color: muted, marginTop: 14, marginBottom: 6 }}>Agent</Text>
        <BottomSheetTextInput value={agent} onChangeText={setAgent} placeholder="default" placeholderTextColor={muted} autoCapitalize="none" autoCorrect={false} style={[input, { fontFamily: MONO }]} />

        {err && (
          <View style={{ marginTop: 14, padding: 12, borderRadius: 11, backgroundColor: 'rgba(239,68,68,0.08)', borderWidth: 1, borderColor: 'rgba(239,68,68,0.3)' }}>
            <Text style={{ fontSize: 13, color: '#ef4444' }}>{err}</Text>
          </View>
        )}
      </BottomSheetScrollView>

      <View style={{ padding: 16, paddingBottom: insets.bottom + 16, borderTopWidth: 1, borderTopColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)' }}>
        <TouchableOpacity onPress={handleSave} disabled={!canSave} activeOpacity={0.85} style={{ height: 48, borderRadius: 9999, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8, backgroundColor: theme.primary, opacity: canSave ? 1 : 0.5 }}>
          {create.isPending && <ActivityIndicator size="small" color={theme.primaryForeground} />}
          <Text style={{ fontSize: 15, fontFamily: 'Roobert-Medium', color: theme.primaryForeground }}>Create schedule</Text>
        </TouchableOpacity>
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
  const theme = useThemeColors();
  const insets = useSafeAreaInsets();
  const fire = useFireProjectTrigger(projectId);
  const update = useUpdateProjectTrigger(projectId);
  const del = useDeleteProjectTrigger(projectId);
  const [prompt, setPrompt] = useState(trigger.prompt_template);

  const fg = isDark ? '#F8F8F8' : '#121215';
  const muted = isDark ? '#9b9b9b' : '#6e6e6e';
  const border = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';
  const iconBg = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)';
  const closeBg = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)';
  const inputBg = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.03)';

  const oneOff = !!trigger.run_at;
  const promptChanged = prompt !== trigger.prompt_template && prompt.trim().length > 0;

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
  const handleSavePrompt = () => {
    if (!promptChanged) return;
    haptics.tap();
    update.mutate({ slug: trigger.slug, input: { prompt_template: prompt } }, {
      onError: (e: any) => Alert.alert('Failed', e?.message || 'Could not save prompt.'),
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

  return (
    <View style={{ flex: 1 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingTop: 4, paddingBottom: 14, borderBottomWidth: 1, borderBottomColor: border }}>
        <View style={{ width: 40, height: 40, borderRadius: 11, backgroundColor: iconBg, alignItems: 'center', justifyContent: 'center' }}>
          <Timer size={19} color={muted} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 16, fontFamily: 'Roobert-Medium', color: fg }} numberOfLines={1}>{trigger.name || trigger.slug}</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 3 }}>
            <Text style={{ fontSize: 12, fontFamily: MONO, color: muted }} numberOfLines={1}>{trigger.slug}</Text>
            <View style={{ paddingHorizontal: 7, paddingVertical: 2, borderRadius: 999, backgroundColor: trigger.enabled ? 'rgba(34,197,94,0.15)' : 'rgba(156,163,175,0.18)' }}>
              <Text style={{ fontSize: 10, fontFamily: 'Roobert-Medium', color: trigger.enabled ? '#16a34a' : muted }}>{trigger.enabled ? 'Active' : 'Paused'}</Text>
            </View>
          </View>
        </View>
        <TouchableOpacity onPress={() => { haptics.tap(); onClose(); }} hitSlop={8} style={{ width: 30, height: 30, borderRadius: 15, backgroundColor: closeBg, alignItems: 'center', justifyContent: 'center' }}>
          <X size={17} color={muted} />
        </TouchableOpacity>
      </View>

      {/* Action bar */}
      <View style={{ flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingTop: 14 }}>
        <TouchableOpacity onPress={handleFire} disabled={fire.isPending} activeOpacity={0.85} style={{ flex: 1, height: 44, borderRadius: 9999, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: theme.primary, opacity: fire.isPending ? 0.6 : 1 }}>
          {fire.isPending ? <ActivityIndicator size="small" color={theme.primaryForeground} /> : <Play size={15} color={theme.primaryForeground} />}
          <Text style={{ fontSize: 14, fontFamily: 'Roobert-Medium', color: theme.primaryForeground }}>Fire now</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={togglePaused} disabled={update.isPending} activeOpacity={0.7} style={{ width: 48, height: 44, borderRadius: 9999, borderWidth: 1, borderColor: border, alignItems: 'center', justifyContent: 'center' }}>
          {trigger.enabled ? <Pause size={17} color={fg} /> : <Play size={17} color={fg} />}
        </TouchableOpacity>
        <TouchableOpacity onPress={handleDelete} disabled={del.isPending} activeOpacity={0.7} style={{ width: 48, height: 44, borderRadius: 9999, borderWidth: 1, borderColor: 'rgba(239,68,68,0.4)', alignItems: 'center', justifyContent: 'center' }}>
          {del.isPending ? <ActivityIndicator size="small" color="#ef4444" /> : <Trash2 size={16} color="#ef4444" />}
        </TouchableOpacity>
      </View>

      <BottomSheetScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 32 }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        {/* Schedule */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <Clock size={14} color={muted} />
          <Text style={{ fontSize: 11, fontFamily: 'Roobert-Medium', color: muted, textTransform: 'uppercase', letterSpacing: 0.5 }}>Schedule</Text>
        </View>
        <Text style={{ fontSize: 14.5, fontFamily: 'Roobert-Medium', color: fg }}>
          {oneOff ? describeRunAt(trigger.run_at) : describeCron(trigger.cron)}
        </Text>
        {!oneOff && trigger.cron && (
          <Text style={{ fontSize: 12.5, fontFamily: MONO, color: muted, marginTop: 4 }}>{trigger.cron} · {trigger.timezone}</Text>
        )}
        {oneOff && <Text style={{ fontSize: 12.5, color: muted, marginTop: 4 }}>Fires a single time, then stays dormant.</Text>}

        {/* Prompt */}
        <Text style={{ fontSize: 11, fontFamily: 'Roobert-Medium', color: muted, textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 22, marginBottom: 8 }}>Prompt</Text>
        <BottomSheetTextInput
          value={prompt}
          onChangeText={setPrompt}
          multiline
          placeholder="What should the agent do?"
          placeholderTextColor={muted}
          style={{ minHeight: 96, borderRadius: 11, borderWidth: 1, borderColor: border, backgroundColor: inputBg, padding: 12, fontSize: 14, color: fg, fontFamily: 'Roobert', textAlignVertical: 'top' }}
        />
        <Text style={{ fontSize: 11.5, color: muted, marginTop: 6 }}>Placeholders: {'{{ message.text }}'} · {'{{ fired_at }}'}</Text>
        {promptChanged && (
          <TouchableOpacity onPress={handleSavePrompt} disabled={update.isPending} activeOpacity={0.85} style={{ height: 42, borderRadius: 9999, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8, backgroundColor: theme.primary, marginTop: 10 }}>
            {update.isPending && <ActivityIndicator size="small" color={theme.primaryForeground} />}
            <Text style={{ fontSize: 14, fontFamily: 'Roobert-Medium', color: theme.primaryForeground }}>Save prompt</Text>
          </TouchableOpacity>
        )}

        {/* Metadata */}
        <View style={{ marginTop: 22, borderRadius: 12, borderWidth: 1, borderColor: border, paddingHorizontal: 14 }}>
          {[
            { l: 'Agent', v: trigger.agent || 'default' },
            { l: 'Last fired', v: relativeTime(trigger.last_fired_at) },
            { l: 'Source', v: trigger.path },
          ].map((row, i) => (
            <View key={row.l} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 11, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: border }}>
              <Text style={{ fontSize: 13, color: muted }}>{row.l}</Text>
              <Text style={{ flex: 1, textAlign: 'right', fontSize: 13, fontFamily: MONO, color: fg }} numberOfLines={1}>{row.v}</Text>
            </View>
          ))}
        </View>
      </BottomSheetScrollView>
    </View>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export function SchedulesPage({
  page,
  projectId,
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

  const bgColor = isDark ? '#090909' : '#FFFFFF';
  const fg = isDark ? '#F8F8F8' : '#121215';
  const muted = isDark ? '#9b9b9b' : '#6e6e6e';
  const border = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';

  const forbidden = isError && /403|forbidden/i.test((error as Error)?.message ?? '');
  const all = useMemo(() => (data?.triggers ?? []).filter((t) => t.type === 'cron'), [data]);
  const errors = data?.errors ?? [];
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? all.filter((t) => (t.name || t.slug).toLowerCase().includes(q)) : all;
  }, [all, search]);
  const activeCount = all.filter((t) => t.enabled).length;
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
        onOpenDrawer={onOpenDrawer}
        onOpenRightDrawer={onOpenRightDrawer}
        isDrawerOpen={isDrawerOpen}
        isRightDrawerOpen={isRightDrawerOpen}
      />

      <PageContent>
        {all.length > 0 && (
          <View style={{ paddingHorizontal: 16, paddingTop: 10 }}>
            <Text style={{ fontSize: 12.5, color: muted }}>{activeCount} of {all.length} active</Text>
          </View>
        )}

        {errors.length > 0 && (
          <View style={{ marginHorizontal: 16, marginTop: 12, padding: 12, borderRadius: 12, backgroundColor: 'rgba(217,119,6,0.08)' }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <TriangleAlert size={15} color="#d97706" />
              <Text style={{ fontSize: 12.5, fontFamily: 'Roobert-Medium', color: '#d97706' }}>Some triggers couldn't be parsed</Text>
            </View>
            {errors.map((e) => (
              <Text key={e.slug + e.path} style={{ fontSize: 12, color: '#d97706', marginTop: 2 }}>{e.path} — {e.error}</Text>
            ))}
          </View>
        )}

        <SearchListHeader value={search} onChangeText={setSearch} placeholder="Search schedules" onAdd={() => { haptics.tap(); addSheetRef.current?.present(); }} />

        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: insets.bottom + 40 }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
          {isLoading ? (
            <View style={{ paddingVertical: 48, alignItems: 'center' }}><ActivityIndicator size="small" color={muted} /></View>
          ) : forbidden ? (
            <View style={{ padding: 40, alignItems: 'center' }}><Text style={{ fontSize: 14, color: muted, textAlign: 'center' }}>You don't have access to this project's schedules.</Text></View>
          ) : isError ? (
            <View style={{ padding: 24, alignItems: 'center', gap: 12 }}>
              <Text style={{ fontSize: 14, color: muted, textAlign: 'center' }}>{(error as Error)?.message ?? 'Failed to load schedules'}</Text>
              <TouchableOpacity onPress={() => refetch()} style={{ paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, borderWidth: 1, borderColor: border }}>
                <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: fg }}>Retry</Text>
              </TouchableOpacity>
            </View>
          ) : filtered.length === 0 ? (
            <View style={{ padding: 40, alignItems: 'center', gap: 12 }}>
              <Timer size={26} color={muted} />
              <Text style={{ fontSize: 14, color: muted, textAlign: 'center' }}>{all.length === 0 ? 'No schedules yet.' : 'No schedules match your search.'}</Text>
              {all.length === 0 && (
                <TouchableOpacity onPress={() => { haptics.tap(); addSheetRef.current?.present(); }} style={{ paddingHorizontal: 16, paddingVertical: 10, borderRadius: 9999, borderWidth: 1, borderColor: border }}>
                  <Text style={{ fontSize: 13.5, fontFamily: 'Roobert-Medium', color: fg }}>New schedule</Text>
                </TouchableOpacity>
              )}
            </View>
          ) : (
            filtered.map((t, i) => {
              const sub = `${t.run_at ? 'One-off' : describeCron(t.cron)} · ${relativeTime(t.last_fired_at)} · ${(t.agent || 'default').toUpperCase()}`;
              return (
                <View key={t.slug}>
                  <TouchableOpacity onPress={() => openRow(t.slug)} activeOpacity={0.6} style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, gap: 12 }}>
                    <View style={{ width: 38, height: 38, borderRadius: 10, backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)', alignItems: 'center', justifyContent: 'center' }}>
                      <Timer size={18} color={muted} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                        <Text style={{ fontSize: 15, fontFamily: 'Roobert-Medium', color: fg }} numberOfLines={1}>{t.name || describeCron(t.cron)}</Text>
                        <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: t.enabled ? '#22c55e' : '#9ca3af' }} />
                      </View>
                      <Text style={{ fontSize: 12.5, color: muted, marginTop: 2 }} numberOfLines={1}>{sub}</Text>
                    </View>
                    <ChevronRight size={18} color={muted} />
                  </TouchableOpacity>
                  {i < filtered.length - 1 && <View style={{ height: 1, backgroundColor: border, marginLeft: 66 }} />}
                </View>
              );
            })
          )}
        </ScrollView>
      </PageContent>

      <BottomSheetModal
        ref={addSheetRef}
        snapPoints={['92%']}
        enableDynamicSizing={false}
        backgroundStyle={{ backgroundColor: getSheetBg(isDark) }}
        handleIndicatorStyle={{ backgroundColor: isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.2)' }}
        keyboardBehavior="interactive"
        keyboardBlurBehavior="restore"
        backdropComponent={(props) => <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} opacity={0.5} />}
      >
        <ScheduleCreateSheet projectId={projectId} onClose={() => addSheetRef.current?.dismiss()} isDark={isDark} />
      </BottomSheetModal>

      <BottomSheetModal
        ref={detailSheetRef}
        snapPoints={['92%']}
        enableDynamicSizing={false}
        onDismiss={() => setSelectedSlug(null)}
        backgroundStyle={{ backgroundColor: getSheetBg(isDark) }}
        handleIndicatorStyle={{ backgroundColor: isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.2)' }}
        keyboardBehavior="interactive"
        keyboardBlurBehavior="restore"
        backdropComponent={(props) => <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} opacity={0.5} />}
      >
        {selected ? (
          <ScheduleDetailSheet projectId={projectId} trigger={selected} onClose={() => detailSheetRef.current?.dismiss()} isDark={isDark} />
        ) : (
          <View style={{ height: 1 }} />
        )}
      </BottomSheetModal>
    </View>
  );
}
