/**
 * WebhooksPage — webhook triggers (web parity: triggers-view, type='webhook').
 * An external POST (HMAC-signed) fires an agent with a rendered prompt. Create
 * stores a signing secret as a project secret, then registers the trigger. List
 * + create sheet + detail sheet (copy URL, sample curl, fire, pause, delete,
 * edit prompt).
 *
 * Mobile branding: PageHeader + PageContent chrome, bottom sheets, design tokens.
 */

import React, { useMemo, useState } from 'react';
import {
  View,
  ScrollView,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Clipboard from 'expo-clipboard';
import * as Crypto from 'expo-crypto';
import { BottomSheetModal, BottomSheetScrollView, BottomSheetTextInput } from '@gorhom/bottom-sheet';
import {
  WebhooksLogoIcon as Webhook,
  PlayIcon as Play,
  PauseIcon as Pause,
  TrashIcon as Trash2,
  XIcon as X,
  CaretRightIcon as ChevronRight,
  WarningIcon as TriangleAlert,
  CopyIcon as Copy,
  CheckCircleIcon as CircleCheck,
  ArrowClockwiseIcon as RefreshCw,
  LockIcon as Lock,
} from '@/lib/icons';
import { PressableSurface } from '@/components/kortix/pressable-surface';
import { Text } from '@/components/ui/text';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { PageHeader } from '@/components/kortix/page-header';
import { PageContent } from '@/components/kortix/page-content';
import { SearchListHeader } from '@/components/kortix/search-list-header';
import { ListRow } from '@/components/kortix/list-row';
import { PageList, StatusDot } from '@/components/kortix/page-list';
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
  useUpsertProjectSecret,
} from '@/lib/projects/hooks';
import type { ProjectTrigger } from '@/lib/projects/projects-client';
import { slugify, relativeTime } from '@/lib/projects/triggers-format';
import { API_URL } from '@/api/config';
import { haptics } from '@/lib/haptics';
import { KortixBottomSheetModal, SheetTitleRow } from '@/components/kortix/sheet';

interface PageTabLike {
  id: string;
  label: string;
}

interface WebhooksPageProps {
  page: PageTabLike;
  projectId: string;
  onOpenDrawer?: () => void;
  onOpenRightDrawer?: () => void;
  isDrawerOpen?: boolean;
  isRightDrawerOpen?: boolean;
}

const MONO = 'Menlo';
const API_ROOT = API_URL.replace(/\/v1\/?$/, '');

function genSecret(): string {
  return Array.from(Crypto.getRandomBytes(24), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function secretEnvFor(slug: string): string {
  return `WEBHOOK_${slug.toUpperCase().replace(/[^A-Z0-9_]/g, '_')}_SECRET`;
}

function webhookUrlFor(projectId: string, slug: string): string {
  return `${API_ROOT}/v1/webhooks/projects/${projectId}/${slug}`;
}

function curlSample(url: string): string {
  return `curl -X POST '${url}' \\\n  -H 'content-type: application/json' \\\n  -H 'x-kortix-signature: sha256=<hmac-sha256 of body using your secret>' \\\n  -d '{"message":{"text":"hello"}}'`;
}

// ─── Create webhook ───────────────────────────────────────────────────────────

function WebhookCreateSheet({
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
  const upsertSecret = useUpsertProjectSecret(projectId);
  const create = useCreateProjectTrigger(projectId);

  const [name, setName] = useState('');
  const [secret, setSecret] = useState(genSecret);
  const [prompt, setPrompt] = useState('');
  const [agent, setAgent] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);

  const fg = isDark ? THEME.dark.foreground : THEME.light.foreground;
  const muted = isDark ? THEME.dark.mutedForeground : THEME.light.mutedForeground;
  const destructiveColor = isDark ? THEME.dark.destructive : THEME.light.destructive;
  const border = withAlpha(fg, isDark ? 0.1 : 0.12);
  const inputBg = withAlpha(fg, isDark ? 0.05 : 0.03);
  const input = { height: 44, borderRadius: 11, borderWidth: 1, borderColor: border, backgroundColor: inputBg, paddingHorizontal: 12, fontSize: 14, color: fg, fontFamily: 'Roobert' as const };

  const slug = slugify(name);
  const previewUrl = webhookUrlFor(projectId, slug || 'your-webhook');
  const canSave = name.trim().length > 0 && prompt.trim().length > 0 && secret.trim().length > 0 && !saving;

  const copySecret = async () => {
    haptics.tap();
    await Clipboard.setStringAsync(secret);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const handleSave = async () => {
    if (!canSave) return;
    setErr(null);
    setSaving(true);
    try {
      const env = secretEnvFor(slug);
      await upsertSecret.mutateAsync({ name: env, value: secret });
      await create.mutateAsync({
        name: name.trim(),
        slug,
        type: 'webhook',
        prompt_template: prompt,
        ...(agent ? { agent } : {}),
        ...(model ? { model } : {}),
        enabled: true,
        secret_env: env,
      });
      haptics.success();
      onClose();
    } catch (e: any) {
      setErr(e?.message || 'Could not create webhook.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <View style={{ flex: 1 }}>
      <SheetTitleRow title="New webhook" onClose={() => { haptics.tap(); onClose(); }} />

      <BottomSheetScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16 }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        <Text style={{ fontSize: 12, fontFamily: 'Roobert-Medium', color: muted, marginBottom: 6 }}>Name</Text>
        <BottomSheetTextInput value={name} onChangeText={setName} placeholder="Stripe events" placeholderTextColor={muted} maxLength={64} style={input} />
        <Text style={{ fontSize: 11.5, fontFamily: MONO, color: muted, marginTop: 6 }}>{previewUrl}</Text>

        <Text style={{ fontSize: 12, fontFamily: 'Roobert-Medium', color: muted, marginTop: 16, marginBottom: 6 }}>Signing secret</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <View style={{ flex: 1, height: 44, borderRadius: 11, borderWidth: 1, borderColor: border, backgroundColor: inputBg, paddingHorizontal: 12, justifyContent: 'center' }}>
            <Text style={{ fontSize: 12.5, fontFamily: MONO, color: fg }} numberOfLines={1}>{secret}</Text>
          </View>
          <Button variant="outline" size="icon" onPress={() => { haptics.tap(); setSecret(genSecret()); }} hitSlop={6}>
            <Icon as={RefreshCw} size={16} color={muted} />
          </Button>
          <Button variant="outline" size="icon" onPress={copySecret} hitSlop={6}>
            <Icon as={copied ? CircleCheck : Copy} size={16} color={copied ? THEME.accent.green : muted} />
          </Button>
        </View>
        <Text style={{ fontSize: 11.5, color: muted, marginTop: 6 }}>Copy it now — sign requests with it. Stored encrypted; never shown again.</Text>

        <Text style={{ fontSize: 12, fontFamily: 'Roobert-Medium', color: muted, marginTop: 16, marginBottom: 6 }}>Prompt</Text>
        <BottomSheetTextInput value={prompt} onChangeText={setPrompt} placeholder="What should the agent do when a request arrives?" placeholderTextColor={muted} multiline style={[input, { height: 96, paddingTop: 10, textAlignVertical: 'top' }]} />

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
          {saving && <ActivityIndicator size="small" color={theme.primaryForeground} />}
          <Text>Create webhook</Text>
        </Button>
      </View>
    </View>
  );
}

// ─── Webhook detail ───────────────────────────────────────────────────────────

function CopyRow({
  label,
  value,
  onCopy,
  copied,
  isDark,
}: {
  label: string;
  value: string;
  onCopy: () => void;
  copied: boolean;
  isDark: boolean;
}) {
  const fg = isDark ? THEME.dark.foreground : THEME.light.foreground;
  const muted = isDark ? THEME.dark.mutedForeground : THEME.light.mutedForeground;
  const border = withAlpha(fg, isDark ? 0.1 : 0.12);
  const inputBg = withAlpha(fg, isDark ? 0.05 : 0.03);
  return (
    <View style={{ borderRadius: 11, borderWidth: 1, borderColor: border, backgroundColor: inputBg, padding: 12 }}>
      <Text style={{ fontSize: 12, fontFamily: MONO, lineHeight: 18, color: fg }}>{value}</Text>
      <Button variant="outline" size="sm" className="mt-2.5 self-start rounded-full" onPress={onCopy}>
        <Icon as={copied ? CircleCheck : Copy} size={13} color={copied ? THEME.accent.green : muted} />
        <Text style={{ color: copied ? THEME.accent.green : muted }}>{copied ? 'Copied' : label}</Text>
      </Button>
    </View>
  );
}

function WebhookDetailSheet({
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
  const [editingPrompt, setEditingPrompt] = useState(false);
  // The detail slides back in only after the editor was open, never on first open.
  const [returning, setReturning] = useState(false);
  const closePromptEditor = () => {
    setReturning(true);
    setEditingPrompt(false);
  };
  const [copied, setCopied] = useState<'url' | 'curl' | null>(null);

  const fg = isDark ? THEME.dark.foreground : THEME.light.foreground;
  const muted = isDark ? THEME.dark.mutedForeground : THEME.light.mutedForeground;
  const destructiveColor = isDark ? THEME.dark.destructive : THEME.light.destructive;
  const border = withAlpha(fg, 0.08);
  const iconBg = withAlpha(fg, isDark ? 0.06 : 0.04);
  const inputBg = withAlpha(fg, isDark ? 0.05 : 0.03);

  const url = trigger.webhook_url ?? webhookUrlFor(projectId, trigger.slug);
  const signed = !!trigger.secret_env;

  const copy = async (key: 'url' | 'curl', text: string) => {
    haptics.tap();
    await Clipboard.setStringAsync(text);
    setCopied(key);
    setTimeout(() => setCopied(null), 1500);
  };

  const handleFire = () => {
    haptics.tap();
    fire.mutate(trigger.slug, {
      onSuccess: (res) => Alert.alert(
        res.status === 'failed' ? 'Failed to fire' : res.status === 'queued' ? 'Queued' : 'Fired',
        res.status === 'failed' ? (res.error || res.reason || 'Could not fire.') : 'The webhook was triggered.',
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
    Alert.alert('Remove webhook', `Remove "${trigger.name || trigger.slug}"? Incoming requests will stop firing.`, [
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
          placeholders="{{ message.text }} · {{ trigger.type }} · {{ fired_at }}"
          saving={update.isPending}
          onSave={handleSavePrompt}
          onBack={closePromptEditor}
        />
      </Animated.View>
    );
  }

  return (
    <Animated.View key="detail" entering={returning ? POP_IN : undefined} style={{ flex: 1 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingTop: 4, paddingBottom: 14, borderBottomWidth: 1, borderBottomColor: border }}>
        <View style={{ width: 40, height: 40, borderRadius: 11, backgroundColor: iconBg, alignItems: 'center', justifyContent: 'center' }}>
          <Webhook size={19} color={muted} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 16, fontFamily: 'Roobert-Medium', color: fg }} numberOfLines={1}>{trigger.name || trigger.slug}</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 3 }}>
            <Text style={{ fontSize: 12, fontFamily: MONO, color: muted }} numberOfLines={1}>{trigger.slug}</Text>
            <View style={{ paddingHorizontal: 7, paddingVertical: 2, borderRadius: 999, backgroundColor: trigger.enabled ? withAlpha(THEME.accent.green, 0.15) : withAlpha(muted, 0.18) }}>
              <Text style={{ fontSize: 10, fontFamily: 'Roobert-Medium', color: trigger.enabled ? THEME.accent.green : muted }}>{trigger.enabled ? 'Active' : 'Paused'}</Text>
            </View>
          </View>
        </View>
        <Button variant="secondary" size="icon" className="rounded-full" onPress={() => { haptics.tap(); onClose(); }} hitSlop={8}>
          <Icon as={X} size={17} color={muted} />
        </Button>
      </View>

      {/* Action bar */}
      <View style={{ flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingTop: 14 }}>
        <Button size="lg" onPress={handleFire} disabled={fire.isPending} className="flex-1 rounded-full">
          {fire.isPending ? <ActivityIndicator size="small" color={theme.primaryForeground} /> : <Icon as={Play} size={15} color={theme.primaryForeground} />}
          <Text>Fire now</Text>
        </Button>
        <Button variant="outline" size="icon" className="rounded-full" onPress={togglePaused} disabled={update.isPending}>
          <Icon as={trigger.enabled ? Pause : Play} size={17} color={fg} />
        </Button>
        <Button variant="outline" size="icon" className="rounded-full" onPress={handleDelete} disabled={del.isPending}>
          {del.isPending ? <ActivityIndicator size="small" color={destructiveColor} /> : <Icon as={Trash2} size={16} color={destructiveColor} />}
        </Button>
      </View>

      <BottomSheetScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 32 }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        {/* Endpoint */}
        <Text style={{ fontSize: 11, fontFamily: 'Roobert-Medium', color: muted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>Endpoint</Text>
        <CopyRow label="Copy URL" value={url} onCopy={() => copy('url', url)} copied={copied === 'url'} isDark={isDark} />

        {/* Signing */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 16, padding: 12, borderRadius: 11, backgroundColor: inputBg }}>
          <Icon as={Lock} size={15} color={signed ? THEME.accent.green : muted} />
          <Text style={{ flex: 1, fontSize: 13, color: fg }}>
            {signed ? <>Signed via <Text style={{ fontFamily: MONO, color: muted }}>{trigger.secret_env}</Text></> : 'Unsigned — anyone with the URL can fire it.'}
          </Text>
        </View>

        {/* Sample */}
        <Text style={{ fontSize: 11, fontFamily: 'Roobert-Medium', color: muted, textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 18, marginBottom: 8 }}>Sample request</Text>
        <CopyRow label="Copy curl" value={curlSample(url)} onCopy={() => copy('curl', curlSample(url))} copied={copied === 'curl'} isDark={isDark} />

        <PromptPreview value={trigger.prompt_template} onEdit={() => setEditingPrompt(true)} />

        <AgentPickerField projectId={projectId} value={trigger.agent} onChange={handleAgentChange} flush />
        <ModelPickerField projectId={projectId} value={trigger.model} onChange={handleModelChange} flush />

        {/* Metadata */}
        <View style={{ marginTop: 22, borderRadius: 12, borderWidth: 1, borderColor: border, paddingHorizontal: 14 }}>
          {[
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
    </Animated.View>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export function WebhooksPage({
  page,
  projectId,
  onOpenDrawer,
  onOpenRightDrawer,
  isDrawerOpen,
  isRightDrawerOpen,
}: WebhooksPageProps) {
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
  const all = useMemo(() => (data?.triggers ?? []).filter((t) => t.type === 'webhook'), [data]);
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
        onAdd={() => { haptics.tap(); addSheetRef.current?.present(); }}
        addLabel="New webhook"
      />

      <PageContent>
        {all.length > 0 && (
          <View style={{ paddingHorizontal: 16, paddingTop: 10 }}>
            <Text style={{ fontSize: 12.5, color: muted }}>{activeCount} of {all.length} active</Text>
          </View>
        )}

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

        <SearchListHeader value={search} onChangeText={setSearch} placeholder="Search webhooks" />

        <PageList
          isLoading={isLoading}
          errorMessage={!forbidden && isError && all.length === 0 ? ((error as Error)?.message ?? 'Unable to load webhooks') : null}
          onRetry={() => void refetch()}
          onRefresh={() => refetch()}
          emptyLabel={
            forbidden
              ? "You don't have access to this project's webhooks"
              : filtered.length === 0
                ? all.length === 0 ? 'No webhooks yet' : 'No matching webhooks'
                : null
          }>
          {filtered.map((t, i) => (
            <ListRow
              key={t.slug}
              title={t.name || t.slug}
              subtitle={`${t.secret_env ? 'Signed' : 'Unsigned'} · ${relativeTime(t.last_fired_at)} · ${t.agent || 'default'}`}
              divider={i < filtered.length - 1}
              onPress={() => openRow(t.slug)}
              right={
                <View className="flex-row items-center gap-3">
                  <StatusDot on={!!t.enabled} label={t.enabled ? 'Active' : 'Paused'} />
                  <Icon as={ChevronRight} size={18} className="text-muted-foreground" />
                </View>
              }
            />
          ))}
        </PageList>
      </PageContent>

      <KortixBottomSheetModal
        ref={addSheetRef}
        snapPoints={['92%']}
        enableDynamicSizing={false}
        keyboardBehavior="interactive"
        keyboardBlurBehavior="restore"
      >
        <WebhookCreateSheet projectId={projectId} onClose={() => addSheetRef.current?.dismiss()} isDark={isDark} />
      </KortixBottomSheetModal>

      <KortixBottomSheetModal
        ref={detailSheetRef}
        snapPoints={['92%']}
        enableDynamicSizing={false}
        onDismiss={() => setSelectedSlug(null)}
        keyboardBehavior="interactive"
        keyboardBlurBehavior="restore"
      >
        {selected ? (
          <WebhookDetailSheet projectId={projectId} trigger={selected} onClose={() => detailSheetRef.current?.dismiss()} isDark={isDark} />
        ) : (
          <View style={{ height: 1 }} />
        )}
      </KortixBottomSheetModal>
    </View>
  );
}
