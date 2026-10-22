import React, { useMemo, useState } from 'react';
import { View, Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BottomSheetScrollView, BottomSheetTextInput } from '@gorhom/bottom-sheet';
import { type TriggerControls } from '@kortix/sdk';
import {
  ClockIcon as Clock,
  PlayIcon as Play,
  PauseIcon as Pause,
  TimerIcon as Timer,
  TrashIcon as Trash2,
  CaretRightIcon as ChevronRight,
  CheckIcon as Check,
} from '@/lib/icons';
import { Text } from '@/components/ui/text';
import { KortixLoader } from '@/components/kortix/kortix-loader';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { PinnedBar, usePinnedBarInset } from '@/components/kortix/pinned-bar';
import { useThemeColors } from '@/lib/theme-colors';
import { MONO_FONT_FAMILY } from '@/lib/utils/mono-font';
import { THEME, withAlpha } from '@/lib/utils/theme';
import { AgentPickerField, ModelPickerField } from '@/components/pages/TriggerAgentModelFields';
import { PromptEditView, PromptPreview } from '@/components/pages/TriggerPromptField';
import { POP_IN, PUSH_IN } from '@/components/kortix/sheet-push';
import Animated from 'react-native-reanimated';
import {
  useCreateProjectTrigger,
  useUpdateProjectTrigger,
  useDeleteProjectTrigger,
  useFireProjectTrigger,
} from '@/lib/projects/hooks';
import type { ProjectTrigger } from '@/lib/projects/projects-client';
import {
  CRON_PRESETS,
  DEFAULT_CRON,
  RUN_AT_PRESETS,
  describeCron,
  describeRunAt,
  relativeTime,
} from '@/lib/projects/triggers-format';
import {
  deviceTimezone,
  normalizeCron,
  timezoneOptions,
  toFiveFieldCron,
} from '@/lib/projects/schedule-input';
import { haptics } from '@/lib/haptics';
import { SheetTitleRow, useSheetBackground } from '@/components/kortix/sheet';
import { SettingsGroup, SettingsRow } from '@/components/kortix/settings-list';
import { useConfirmDialog } from '@/components/kortix/confirm-dialog';
import { useToast } from '@/components/kortix/toast-provider';

const MONO = MONO_FONT_FAMILY;
/** The detail sheet's pinned action row: `Button size="lg"`, 44pt. */
const ACTION_BAR_HEIGHT = 44;

// ─── Create schedule ──────────────────────────────────────────────────────────

export function ScheduleCreateSheet({
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
  // The field shows the usual 5-field cron; `normalizeCron` sends the stored
  // 6-field form (COR-155).
  const [cron, setCron] = useState(() => toFiveFieldCron(DEFAULT_CRON));
  const [runAt, setRunAt] = useState<string | null>(null);
  // The device's zone, not UTC (COR-155). The picker lists it first when the
  // fixed list lacks it.
  const [timezone, setTimezone] = useState(deviceTimezone);
  const zones = useMemo(() => timezoneOptions(deviceTimezone()), []);
  const cronResult = useMemo(() => normalizeCron(cron), [cron]);
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
    (mode === 'recurring' ? cronResult.ok : !!runAt) &&
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
        ...(mode === 'recurring' && cronResult.ok
          ? { cron: cronResult.cron, timezone }
          : { run_at: runAt!, timezone }),
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
                const on = cronResult.ok && cronResult.cron === p.cron;
                return (
                  <Pressable key={p.cron} onPress={() => { haptics.selection(); setCron(toFiveFieldCron(p.cron)); }} style={{ paddingHorizontal: 12, paddingVertical: 8, borderRadius: 9999, borderWidth: 1.5, borderColor: on ? theme.primary : border, backgroundColor: on ? theme.primaryLight : 'transparent' }}>
                    <Text style={{ fontSize: 12.5, fontFamily: 'Roobert-Medium', color: on ? theme.primary : muted }}>{p.label}</Text>
                  </Pressable>
                );
              })}
            </View>
            <Text style={{ fontSize: 12, fontFamily: 'Roobert-Medium', color: muted, marginBottom: 6 }}>Custom cron</Text>
            <BottomSheetTextInput value={cron} onChangeText={setCron} placeholder="0 9 * * *" placeholderTextColor={muted} autoCapitalize="none" autoCorrect={false} style={[input, { fontFamily: MONO }]} />
            {/* No helper line (inputs carry no descriptions); a line shows only
                when the cron is invalid: it names the field and the range, or
                the 5-field format. Create stays disabled until it is valid. */}
            {!cronResult.ok ? (
              <Text style={{ fontSize: 11.5, color: destructiveColor, marginTop: 6 }}>{cronResult.error}</Text>
            ) : null}

            {/* timezone */}
            <Text style={{ fontSize: 12, fontFamily: 'Roobert-Medium', color: muted, marginTop: 16, marginBottom: 6 }}>Timezone</Text>
            <Pressable onPress={() => { haptics.tap(); setTzOpen((v) => !v); }} style={{ ...input, flexDirection: 'row', alignItems: 'center' }}>
              <Text style={{ flex: 1, fontSize: 14, color: fg, fontFamily: MONO }}>{timezone}</Text>
              <Icon as={ChevronRight} size={16} color={muted} style={{ transform: [{ rotate: tzOpen ? '90deg' : '0deg' }] }} />
            </Pressable>
            {tzOpen && (
              <View style={{ marginTop: 8, borderRadius: 11, borderWidth: 1, borderColor: border, overflow: 'hidden' }}>
                {zones.map((tz, i) => (
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
          {create.isPending && <KortixLoader size="small" forceTheme={isDark ? 'light' : 'dark'} />}
          <Text>Create schedule</Text>
        </Button>
      </View>
    </View>
  );
}

// ─── Schedule detail ──────────────────────────────────────────────────────────

export function ScheduleDetailSheet({
  projectId,
  trigger,
  controls,
  onClose,
  isDark,
}: {
  projectId: string;
  trigger: ProjectTrigger;
  /** Which controls the viewer gets: one leaf per control. */
  controls: TriggerControls;
  onClose: () => void;
  isDark: boolean;
}) {
  const sheetBackground = useSheetBackground();
  const { canFire, canUpdate, canDelete } = controls;
  const hasActions = canFire || canUpdate || canDelete;
  const barInset = usePinnedBarInset(hasActions ? ACTION_BAR_HEIGHT : 0);
  const fire = useFireProjectTrigger(projectId);
  const update = useUpdateProjectTrigger(projectId);
  const del = useDeleteProjectTrigger(projectId);
  const toast = useToast();
  const { confirm, dialog: confirmDialog } = useConfirmDialog();
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

  // Every schedule toast names the schedule, behind its clock (web's trigger toast).
  const entity = { icon: Clock, label: trigger.name || trigger.slug };

  const handleFire = () => {
    haptics.tap();
    fire.mutate(trigger.slug, {
      onSuccess: (res) => {
        if (res.status === 'failed') {
          toast.error('Unable to fire the schedule', { entity, description: res.error || res.reason || 'Try again.' });
        } else {
          toast.success(res.status === 'queued' ? 'Schedule queued' : 'Schedule fired', { entity });
        }
      },
      onError: (e: any) => toast.error('Unable to fire the schedule', { entity, description: e?.message || 'Try again.' }),
    });
  };
  const togglePaused = () => {
    haptics.tap();
    update.mutate({ slug: trigger.slug, input: { enabled: !trigger.enabled } }, {
      onError: (e: any) => toast.error('Unable to update the schedule', { entity, description: e?.message || 'Try again.' }),
    });
  };
  const handleSavePrompt = (next: string) => {
    haptics.tap();
    update.mutate({ slug: trigger.slug, input: { prompt_template: next } }, {
      onSuccess: closePromptEditor,
      onError: (e: any) => toast.error('Unable to save the prompt', { entity, description: e?.message || 'Try again.' }),
    });
  };
  const handleAgentChange = (agent: string) => {
    update.mutate({ slug: trigger.slug, input: { agent } }, {
      onError: (e: any) => toast.error('Unable to change the agent', { entity, description: e?.message || 'Try again.' }),
    });
  };
  const handleModelChange = (model: string | null) => {
    update.mutate({ slug: trigger.slug, input: { model } }, {
      onError: (e: any) => toast.error('Unable to change the model', { entity, description: e?.message || 'Try again.' }),
    });
  };
  const handleDelete = () => {
    confirm({
      title: 'Remove schedule',
      description: `Remove "${trigger.name || trigger.slug}"? This stops future runs.`,
      confirmLabel: 'Remove',
      destructive: true,
      onConfirm: () => {
        haptics.medium();
        del.mutate(trigger.slug, {
          onSuccess: onClose,
          onError: (e: any) => toast.error('Unable to remove the schedule', { entity, description: e?.message || 'Try again.' }),
        });
      },
    });
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

        <PromptPreview
          value={trigger.prompt_template}
          onEdit={canUpdate ? () => setEditingPrompt(true) : undefined}
        />

        <AgentPickerField
          projectId={projectId}
          value={trigger.agent}
          onChange={handleAgentChange}
          disabled={!canUpdate}
          flush
        />
        <ModelPickerField
          projectId={projectId}
          value={trigger.model}
          onChange={handleModelChange}
          disabled={!canUpdate}
          flush
        />

        <SettingsGroup>
          <SettingsRow label="Last fired" value={relativeTime(trigger.last_fired_at)} />
          <SettingsRow label="Source" value={trigger.path} />
        </SettingsGroup>
      </BottomSheetScrollView>

      {/* Pinned action bar, floating over a fade of the sheet, the content
          scrolling under it — the agent and skill detail's fade (Jay,
          2026-09-22). Fire now · pause or resume · delete, each on its own
          leaf. Without Fire now, Pause/Resume takes its full-width slot; with
          no control at all there is no bar. */}
      {hasActions ? (
        <PinnedBar controlHeight={ACTION_BAR_HEIGHT} background={sheetBackground} className="gap-3 px-4">
          {canFire ? (
            <Button size="lg" onPress={handleFire} disabled={fire.isPending} className="flex-1 rounded-full">
              <Icon as={Play} size={16} className="text-primary-foreground" />
              <Text>{fire.isPending ? 'Firing…' : 'Fire now'}</Text>
            </Button>
          ) : null}
          {canUpdate ? (
            <Button
              variant="secondary"
              size="lg"
              className={canFire ? 'rounded-full' : 'flex-1 rounded-full'}
              onPress={togglePaused}
              disabled={update.isPending}
              accessibilityLabel={trigger.enabled ? 'Pause schedule' : 'Resume schedule'}>
              <Icon as={trigger.enabled ? Pause : Play} size={16} className="text-foreground" />
              <Text>{trigger.enabled ? 'Pause' : 'Resume'}</Text>
            </Button>
          ) : null}
          {canDelete ? (
            <Button
              variant="secondary"
              size="icon"
              className="rounded-full"
              onPress={handleDelete}
              disabled={del.isPending}
              accessibilityLabel="Delete schedule">
              <Icon as={Trash2} size={18} className="text-destructive" />
            </Button>
          ) : null}
        </PinnedBar>
      ) : null}
      </View>
      {confirmDialog}
    </Animated.View>
  );
}
