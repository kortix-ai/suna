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
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Clipboard from 'expo-clipboard';
import {
  BottomSheetModal,
  BottomSheetBackdrop,
  BottomSheetScrollView,
  BottomSheetTextInput,
} from '@gorhom/bottom-sheet';
import {
  Webhook,
  Play,
  Pause,
  Trash2,
  X,
  ChevronRight,
  TriangleAlert,
  Copy,
  CircleCheck,
  RefreshCw,
  Lock,
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
  useUpsertProjectSecret,
} from '@/lib/projects/hooks';
import type { ProjectTrigger } from '@/lib/projects/projects-client';
import { slugify, relativeTime } from '@/lib/projects/triggers-format';
import { API_URL } from '@/api/config';
import { haptics } from '@/lib/haptics';

interface PageTabLike {
  id: string;
  label: string;
  icon: string;
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
  const hex = '0123456789abcdef';
  let s = '';
  for (let i = 0; i < 48; i++) s += hex[Math.floor(Math.random() * 16)];
  return s;
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
  const [agent, setAgent] = useState('default');
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);

  const fg = isDark ? '#F8F8F8' : '#121215';
  const muted = isDark ? '#9b9b9b' : '#6e6e6e';
  const border = isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.12)';
  const inputBg = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.03)';
  const closeBg = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)';
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
        agent: agent.trim() || 'default',
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
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingTop: 4, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)' }}>
        <Text style={{ flex: 1, fontSize: 18, fontFamily: 'Roobert-Medium', color: fg }}>New webhook</Text>
        <TouchableOpacity onPress={() => { haptics.tap(); onClose(); }} hitSlop={8} style={{ width: 30, height: 30, borderRadius: 15, backgroundColor: closeBg, alignItems: 'center', justifyContent: 'center' }}>
          <X size={17} color={muted} />
        </TouchableOpacity>
      </View>

      <BottomSheetScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16 }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        <Text style={{ fontSize: 12, fontFamily: 'Roobert-Medium', color: muted, marginBottom: 6 }}>Name</Text>
        <BottomSheetTextInput value={name} onChangeText={setName} placeholder="Stripe events" placeholderTextColor={muted} maxLength={64} style={input} />
        <Text style={{ fontSize: 11.5, fontFamily: MONO, color: muted, marginTop: 6 }}>{previewUrl}</Text>

        <Text style={{ fontSize: 12, fontFamily: 'Roobert-Medium', color: muted, marginTop: 16, marginBottom: 6 }}>Signing secret</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <View style={{ flex: 1, height: 44, borderRadius: 11, borderWidth: 1, borderColor: border, backgroundColor: inputBg, paddingHorizontal: 12, justifyContent: 'center' }}>
            <Text style={{ fontSize: 12.5, fontFamily: MONO, color: fg }} numberOfLines={1}>{secret}</Text>
          </View>
          <TouchableOpacity onPress={() => { haptics.tap(); setSecret(genSecret()); }} hitSlop={6} style={{ width: 44, height: 44, borderRadius: 11, borderWidth: 1, borderColor: border, alignItems: 'center', justifyContent: 'center' }}>
            <RefreshCw size={16} color={muted} />
          </TouchableOpacity>
          <TouchableOpacity onPress={copySecret} hitSlop={6} style={{ width: 44, height: 44, borderRadius: 11, borderWidth: 1, borderColor: border, alignItems: 'center', justifyContent: 'center' }}>
            {copied ? <CircleCheck size={16} color="#16a34a" /> : <Copy size={16} color={muted} />}
          </TouchableOpacity>
        </View>
        <Text style={{ fontSize: 11.5, color: muted, marginTop: 6 }}>Copy it now — sign requests with it. Stored encrypted; never shown again.</Text>

        <Text style={{ fontSize: 12, fontFamily: 'Roobert-Medium', color: muted, marginTop: 16, marginBottom: 6 }}>Prompt</Text>
        <BottomSheetTextInput value={prompt} onChangeText={setPrompt} placeholder="What should the agent do when a request arrives?" placeholderTextColor={muted} multiline style={[input, { height: 96, paddingTop: 10, textAlignVertical: 'top' }]} />

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
          {saving && <ActivityIndicator size="small" color={theme.primaryForeground} />}
          <Text style={{ fontSize: 15, fontFamily: 'Roobert-Medium', color: theme.primaryForeground }}>Create webhook</Text>
        </TouchableOpacity>
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
  const fg = isDark ? '#F8F8F8' : '#121215';
  const muted = isDark ? '#9b9b9b' : '#6e6e6e';
  const border = isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.12)';
  const inputBg = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.03)';
  return (
    <View style={{ borderRadius: 11, borderWidth: 1, borderColor: border, backgroundColor: inputBg, padding: 12 }}>
      <Text style={{ fontSize: 12, fontFamily: MONO, lineHeight: 18, color: fg }}>{value}</Text>
      <TouchableOpacity onPress={onCopy} activeOpacity={0.7} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', marginTop: 10, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 9999, borderWidth: 1, borderColor: border }}>
        {copied ? <CircleCheck size={13} color="#16a34a" /> : <Copy size={13} color={muted} />}
        <Text style={{ fontSize: 12, fontFamily: 'Roobert-Medium', color: copied ? '#16a34a' : muted }}>{copied ? 'Copied' : label}</Text>
      </TouchableOpacity>
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
  const [prompt, setPrompt] = useState(trigger.prompt_template);
  const [copied, setCopied] = useState<'url' | 'curl' | null>(null);

  const fg = isDark ? '#F8F8F8' : '#121215';
  const muted = isDark ? '#9b9b9b' : '#6e6e6e';
  const border = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';
  const iconBg = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)';
  const closeBg = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)';
  const inputBg = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.03)';

  const url = trigger.webhook_url ?? webhookUrlFor(projectId, trigger.slug);
  const signed = !!trigger.secret_env;
  const promptChanged = prompt !== trigger.prompt_template && prompt.trim().length > 0;

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
  const handleSavePrompt = () => {
    if (!promptChanged) return;
    haptics.tap();
    update.mutate({ slug: trigger.slug, input: { prompt_template: prompt } }, {
      onError: (e: any) => Alert.alert('Failed', e?.message || 'Could not save prompt.'),
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

  return (
    <View style={{ flex: 1 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingTop: 4, paddingBottom: 14, borderBottomWidth: 1, borderBottomColor: border }}>
        <View style={{ width: 40, height: 40, borderRadius: 11, backgroundColor: iconBg, alignItems: 'center', justifyContent: 'center' }}>
          <Webhook size={19} color={muted} />
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
        {/* Endpoint */}
        <Text style={{ fontSize: 11, fontFamily: 'Roobert-Medium', color: muted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>Endpoint</Text>
        <CopyRow label="Copy URL" value={url} onCopy={() => copy('url', url)} copied={copied === 'url'} isDark={isDark} />

        {/* Signing */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 16, padding: 12, borderRadius: 11, backgroundColor: inputBg }}>
          <Lock size={15} color={signed ? '#16a34a' : muted} />
          <Text style={{ flex: 1, fontSize: 13, color: fg }}>
            {signed ? <>Signed via <Text style={{ fontFamily: MONO, color: muted }}>{trigger.secret_env}</Text></> : 'Unsigned — anyone with the URL can fire it.'}
          </Text>
        </View>

        {/* Sample */}
        <Text style={{ fontSize: 11, fontFamily: 'Roobert-Medium', color: muted, textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 18, marginBottom: 8 }}>Sample request</Text>
        <CopyRow label="Copy curl" value={curlSample(url)} onCopy={() => copy('curl', curlSample(url))} copied={copied === 'curl'} isDark={isDark} />

        {/* Prompt */}
        <Text style={{ fontSize: 11, fontFamily: 'Roobert-Medium', color: muted, textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 18, marginBottom: 8 }}>Prompt</Text>
        <BottomSheetTextInput
          value={prompt}
          onChangeText={setPrompt}
          multiline
          placeholder="What should the agent do?"
          placeholderTextColor={muted}
          style={{ minHeight: 96, borderRadius: 11, borderWidth: 1, borderColor: border, backgroundColor: inputBg, padding: 12, fontSize: 14, color: fg, fontFamily: 'Roobert', textAlignVertical: 'top' }}
        />
        <Text style={{ fontSize: 11.5, color: muted, marginTop: 6 }}>Placeholders: {'{{ message.text }}'} · {'{{ trigger.type }}'} · {'{{ fired_at }}'}</Text>
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

  const bgColor = isDark ? '#090909' : '#FFFFFF';
  const fg = isDark ? '#F8F8F8' : '#121215';
  const muted = isDark ? '#9b9b9b' : '#6e6e6e';
  const border = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';

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

        <SearchListHeader value={search} onChangeText={setSearch} placeholder="Search webhooks" onAdd={() => { haptics.tap(); addSheetRef.current?.present(); }} />

        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: insets.bottom + 40 }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
          {isLoading ? (
            <View style={{ paddingVertical: 48, alignItems: 'center' }}><ActivityIndicator size="small" color={muted} /></View>
          ) : forbidden ? (
            <View style={{ padding: 40, alignItems: 'center' }}><Text style={{ fontSize: 14, color: muted, textAlign: 'center' }}>You don't have access to this project's webhooks.</Text></View>
          ) : isError ? (
            <View style={{ padding: 24, alignItems: 'center', gap: 12 }}>
              <Text style={{ fontSize: 14, color: muted, textAlign: 'center' }}>{(error as Error)?.message ?? 'Failed to load webhooks'}</Text>
              <TouchableOpacity onPress={() => refetch()} style={{ paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, borderWidth: 1, borderColor: border }}>
                <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: fg }}>Retry</Text>
              </TouchableOpacity>
            </View>
          ) : filtered.length === 0 ? (
            <View style={{ padding: 40, alignItems: 'center', gap: 12 }}>
              <Webhook size={26} color={muted} />
              <Text style={{ fontSize: 14, color: muted, textAlign: 'center' }}>{all.length === 0 ? 'No webhooks yet.' : 'No webhooks match your search.'}</Text>
              {all.length === 0 && (
                <TouchableOpacity onPress={() => { haptics.tap(); addSheetRef.current?.present(); }} style={{ paddingHorizontal: 16, paddingVertical: 10, borderRadius: 9999, borderWidth: 1, borderColor: border }}>
                  <Text style={{ fontSize: 13.5, fontFamily: 'Roobert-Medium', color: fg }}>New webhook</Text>
                </TouchableOpacity>
              )}
            </View>
          ) : (
            filtered.map((t, i) => {
              const sub = `${t.secret_env ? 'Signed' : 'Unsigned'} · ${relativeTime(t.last_fired_at)} · ${(t.agent || 'default').toUpperCase()}`;
              return (
                <View key={t.slug}>
                  <TouchableOpacity onPress={() => openRow(t.slug)} activeOpacity={0.6} style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, gap: 12 }}>
                    <View style={{ width: 38, height: 38, borderRadius: 10, backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)', alignItems: 'center', justifyContent: 'center' }}>
                      <Webhook size={18} color={muted} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                        <Text style={{ fontSize: 15, fontFamily: 'Roobert-Medium', color: fg }} numberOfLines={1}>{t.name || t.slug}</Text>
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
        <WebhookCreateSheet projectId={projectId} onClose={() => addSheetRef.current?.dismiss()} isDark={isDark} />
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
          <WebhookDetailSheet projectId={projectId} trigger={selected} onClose={() => detailSheetRef.current?.dismiss()} isDark={isDark} />
        ) : (
          <View style={{ height: 1 }} />
        )}
      </BottomSheetModal>
    </View>
  );
}
