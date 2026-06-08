/**
 * SandboxPage — the project's runtime image (web parity: customize/sections/
 * sandbox-view = SandboxSnapshotCard + WarmPoolCard).
 *
 * Sessions boot from a sandbox template. This surface owns:
 *   • Sandbox templates list (platform default + repo/UI templates) — edit,
 *     delete, rebuild.
 *   • Latest-failure banner with "Retry build" + "Fix with agent" (spins up a
 *     session to diagnose the failed build).
 *   • Recent build history (last 10) with status + source + error.
 *   • Warm pool card (gated on warm_pool_available) — keep N sandboxes pre-booted
 *     so new sessions open instantly; live ready/warming counts.
 *
 * Mobile branding: PageHeader + PageContent chrome, bottom sheets, design tokens.
 */

import React, { useEffect, useMemo, useState } from 'react';
import {
  View,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  Alert,
  Switch,
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
  Container,
  Package,
  FileCode,
  CircleCheck,
  CircleX,
  Clock,
  Loader,
  Sparkles,
  SquarePen,
  Trash2,
  RefreshCw,
  Plus,
  Minus,
  Zap,
  X,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react-native';
import { Text } from '@/components/ui/text';
import { PageHeader } from '@/components/ui/page-header';
import { PageContent } from '@/components/ui/page-content';
import { useThemeColors, getSheetBg } from '@/lib/theme-colors';
import {
  useProject,
  useProjectSnapshots,
  useCreateSandboxTemplate,
  useUpdateSandboxTemplate,
  useBuildSandboxTemplate,
  useDeleteSandboxTemplate,
  useRebuildSnapshot,
  useFixSandboxWithAgent,
  useWarmPoolStatus,
  useUpdateWarmPool,
} from '@/lib/projects/hooks';
import type {
  KortixProject,
  SandboxTemplate,
  ProjectSnapshotBuild,
  ProjectSnapshotStatus,
  SnapshotErrorCategory,
} from '@/lib/projects/projects-client';
import { haptics } from '@/lib/haptics';

const MONO = 'Menlo';
const MAX_WARM = 25;
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

interface PageTabLike {
  id: string;
  label: string;
  icon: string;
}

interface SandboxPageProps {
  page: PageTabLike;
  projectId: string;
  onOpenDrawer?: () => void;
  onOpenRightDrawer?: () => void;
  isDrawerOpen?: boolean;
  isRightDrawerOpen?: boolean;
  /** Navigate to a session by id (used by Fix-with-agent). */
  onOpenSession?: (sessionId: string) => void;
}

// ─── labels / helpers (web parity) ────────────────────────────────────────────

const STATUS_STYLE: Record<ProjectSnapshotStatus, { label: string; color: string; bg: string; icon: LucideIcon; spin?: boolean }> = {
  ready: { label: 'Ready', color: '#16a34a', bg: 'rgba(34,197,94,0.12)', icon: CircleCheck },
  building: { label: 'Building', color: '#2563eb', bg: 'rgba(59,130,246,0.12)', icon: Loader, spin: true },
  failed: { label: 'Failed', color: '#ef4444', bg: 'rgba(239,68,68,0.12)', icon: CircleX },
};

const CATEGORY_LABEL: Record<SnapshotErrorCategory, string> = {
  dockerfile: 'Dockerfile build failed',
  git: 'Repository access failed',
  tunnel: 'Sandbox callback unreachable',
  provider: 'Sandbox provider error',
  timeout: 'Build timed out',
  runtime: 'Runtime artifact missing',
  unknown: 'Build failed',
};

const DAYTONA_STATE_LABEL: Record<string, { label: string; tone: 'ok' | 'busy' | 'fail' | 'idle' }> = {
  active: { label: 'Ready', tone: 'ok' },
  pulling: { label: 'Pulling', tone: 'busy' },
  building: { label: 'Building', tone: 'busy' },
  removing: { label: 'Removing', tone: 'busy' },
  error: { label: 'Error', tone: 'fail' },
  build_failed: { label: 'Build failed', tone: 'fail' },
  missing: { label: 'Not built yet', tone: 'idle' },
};

function describeState(state: string): { label: string; tone: 'ok' | 'busy' | 'fail' | 'idle' } {
  return DAYTONA_STATE_LABEL[state] ?? { label: state || 'Unknown', tone: 'idle' };
}

function formatRelative(input: string | null | undefined): string {
  if (!input) return '—';
  const then = new Date(input).getTime();
  if (!Number.isFinite(then)) return input ?? '—';
  const minutes = Math.round((Date.now() - then) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(input).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
}

// ─── small UI pieces ──────────────────────────────────────────────────────────

function StatusPill({ status }: { status: ProjectSnapshotStatus }) {
  const s = STATUS_STYLE[status];
  const Icon = s.icon;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 2.5, borderRadius: 999, backgroundColor: s.bg }}>
      {s.spin ? <ActivityIndicator size="small" color={s.color} /> : <Icon size={12} color={s.color} />}
      <Text style={{ fontSize: 11, fontFamily: 'Roobert-Medium', color: s.color }}>{s.label}</Text>
    </View>
  );
}

function StateBadge({ state }: { state: string }) {
  const info = describeState(state);
  const color = info.tone === 'ok' ? '#16a34a' : info.tone === 'busy' ? '#2563eb' : info.tone === 'fail' ? '#ef4444' : '#9b9b9b';
  const bg = info.tone === 'ok' ? 'rgba(34,197,94,0.12)' : info.tone === 'busy' ? 'rgba(59,130,246,0.12)' : info.tone === 'fail' ? 'rgba(239,68,68,0.12)' : 'rgba(156,163,175,0.16)';
  const Icon = info.tone === 'ok' ? CircleCheck : info.tone === 'fail' ? CircleX : Clock;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 2.5, borderRadius: 999, backgroundColor: bg }}>
      {info.tone === 'busy' ? <ActivityIndicator size="small" color={color} /> : <Icon size={12} color={color} />}
      <Text style={{ fontSize: 11, fontFamily: 'Roobert-Medium', color }}>{info.label}</Text>
    </View>
  );
}

function SectionLabel({ children, color }: { children: React.ReactNode; color: string }) {
  return (
    <Text style={{ fontSize: 11, fontFamily: 'Roobert-Medium', color, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>
      {children}
    </Text>
  );
}

// ─── template row ─────────────────────────────────────────────────────────────

function TemplateRow({
  template,
  canManage,
  isDark,
  isLast,
  onEdit,
  onDelete,
  onRebuild,
  rebuilding,
  deleting,
}: {
  template: SandboxTemplate;
  canManage: boolean;
  isDark: boolean;
  isLast: boolean;
  onEdit: (t: SandboxTemplate) => void;
  onDelete: (t: SandboxTemplate) => void;
  onRebuild: (t: SandboxTemplate) => void;
  rebuilding: boolean;
  deleting: boolean;
}) {
  const fg = isDark ? '#F8F8F8' : '#121215';
  const muted = isDark ? '#9b9b9b' : '#6e6e6e';
  const border = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';
  const chipBg = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)';

  const Icon = template.is_default ? Container : template.has_image ? Package : FileCode;
  const source = template.is_default
    ? 'Platform default · shared by every project'
    : template.has_image
      ? `Image: ${template.image}`
      : `Dockerfile: ${template.dockerfile_path}`;
  const sourceTag = template.source === 'platform' ? 'platform' : template.source === 'ui' ? 'UI' : 'kortix.toml';
  const editable = canManage && !!template.template_id && !template.is_default;
  const buildable = canManage && !!template.template_id;

  return (
    <View style={{ paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: isLast ? 0 : 1, borderBottomColor: border }}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
        <Icon size={17} color={muted} style={{ marginTop: 1 }} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <Text style={{ fontSize: 14.5, fontFamily: 'Roobert-Medium', color: fg }} numberOfLines={1}>{template.name}</Text>
            <View style={{ paddingHorizontal: 6, paddingVertical: 1.5, borderRadius: 5, backgroundColor: chipBg }}>
              <Text style={{ fontSize: 11, fontFamily: MONO, color: muted }}>{template.slug}</Text>
            </View>
            <Text style={{ fontSize: 9.5, fontFamily: 'Roobert-Medium', color: muted, textTransform: 'uppercase', letterSpacing: 0.4, opacity: 0.7 }}>{sourceTag}</Text>
          </View>
          <Text style={{ fontSize: 12, color: muted, marginTop: 3 }} numberOfLines={2}>
            {source} · {template.cpu} vCPU · {template.memory_gb} GiB · {template.disk_gb} GiB disk
          </Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
            <StateBadge state={template.daytona_state} />
            {editable && (
              <>
                <TouchableOpacity onPress={() => { haptics.tap(); onEdit(template); }} hitSlop={6} style={{ width: 30, height: 30, borderRadius: 8, borderWidth: 1, borderColor: border, alignItems: 'center', justifyContent: 'center' }}>
                  <SquarePen size={14} color={muted} />
                </TouchableOpacity>
                <TouchableOpacity onPress={() => { haptics.tap(); onDelete(template); }} disabled={deleting} hitSlop={6} style={{ width: 30, height: 30, borderRadius: 8, borderWidth: 1, borderColor: 'rgba(239,68,68,0.35)', alignItems: 'center', justifyContent: 'center' }}>
                  {deleting ? <ActivityIndicator size="small" color="#ef4444" /> : <Trash2 size={14} color="#ef4444" />}
                </TouchableOpacity>
              </>
            )}
            {buildable && (
              <TouchableOpacity onPress={() => { haptics.tap(); onRebuild(template); }} disabled={rebuilding} activeOpacity={0.7} style={{ flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 10, height: 30, borderRadius: 8, borderWidth: 1, borderColor: border }}>
                {rebuilding ? <ActivityIndicator size="small" color={muted} /> : <RefreshCw size={13} color={muted} />}
                <Text style={{ fontSize: 12.5, fontFamily: 'Roobert-Medium', color: fg }}>Rebuild</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>
      </View>
    </View>
  );
}

// ─── template create / edit sheet ─────────────────────────────────────────────

type Mode = 'image' | 'dockerfile';

function NumField({ label, value, onChange, isDark }: { label: string; value: string; onChange: (v: string) => void; isDark: boolean }) {
  const fg = isDark ? '#F8F8F8' : '#121215';
  const muted = isDark ? '#9b9b9b' : '#6e6e6e';
  const border = isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.12)';
  const inputBg = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.03)';
  return (
    <View style={{ flex: 1 }}>
      <Text style={{ fontSize: 11.5, fontFamily: 'Roobert-Medium', color: muted, marginBottom: 6 }}>{label}</Text>
      <BottomSheetTextInput
        value={value}
        onChangeText={(t) => onChange(t.replace(/[^0-9]/g, ''))}
        keyboardType="number-pad"
        style={{ height: 44, borderRadius: 11, borderWidth: 1, borderColor: border, backgroundColor: inputBg, paddingHorizontal: 12, fontSize: 14, color: fg, fontFamily: MONO, textAlign: 'center' }}
      />
    </View>
  );
}

function SandboxTemplateSheet({
  projectId,
  template,
  onClose,
  isDark,
}: {
  projectId: string;
  template: SandboxTemplate | null;
  onClose: () => void;
  isDark: boolean;
}) {
  const theme = useThemeColors();
  const insets = useSafeAreaInsets();
  const isEdit = !!template;
  const create = useCreateSandboxTemplate(projectId);
  const update = useUpdateSandboxTemplate(projectId);

  const [name, setName] = useState(template?.name ?? '');
  const [slug, setSlug] = useState(template?.slug ?? '');
  const [slugEdited, setSlugEdited] = useState(!!template);
  const [mode, setMode] = useState<Mode>(template && !template.image ? 'dockerfile' : 'image');
  const [image, setImage] = useState(template?.image ?? '');
  const [dockerfilePath, setDockerfilePath] = useState(template?.dockerfile_path ?? '');
  const [entrypoint, setEntrypoint] = useState(template?.entrypoint ?? '');
  const [cpu, setCpu] = useState(template ? String(template.cpu) : '2');
  const [memoryGb, setMemoryGb] = useState(template ? String(template.memory_gb) : '4');
  const [diskGb, setDiskGb] = useState(template ? String(template.disk_gb) : '20');
  const [err, setErr] = useState<string | null>(null);

  // Auto-slug from name until the user types a slug manually.
  useEffect(() => {
    if (!slugEdited) setSlug(slugify(name));
  }, [name, slugEdited]);

  const fg = isDark ? '#F8F8F8' : '#121215';
  const muted = isDark ? '#9b9b9b' : '#6e6e6e';
  const border = isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.12)';
  const inputBg = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.03)';
  const closeBg = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)';
  const input = { height: 44, borderRadius: 11, borderWidth: 1, borderColor: border, backgroundColor: inputBg, paddingHorizontal: 12, fontSize: 14, color: fg, fontFamily: 'Roobert' as const };

  const slugError = useMemo(() => {
    if (!slug) return null;
    if (slug === 'default') return 'Slug "default" is reserved.';
    if (!SLUG_RE.test(slug)) return 'Lowercase letters, digits, dashes or underscores (1–64).';
    return null;
  }, [slug]);
  const sourceError = useMemo(() => {
    if (mode === 'image' && !image.trim()) return 'Image reference required.';
    if (mode === 'dockerfile' && !dockerfilePath.trim()) return 'Dockerfile path required.';
    if (mode === 'image' && image.trim().endsWith(':latest')) return 'Pin a specific tag instead of "latest".';
    return null;
  }, [mode, image, dockerfilePath]);

  const parsePosInt = (s: string): number | undefined => {
    const n = Number.parseInt(s, 10);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };

  const canSubmit = !!slug && !slugError && !sourceError && !!name.trim() && !create.isPending && !update.isPending;
  const submitting = create.isPending || update.isPending;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setErr(null);
    try {
      if (isEdit) {
        await update.mutateAsync({
          templateId: template!.template_id!,
          input: {
            name: name.trim(),
            image: mode === 'image' ? image.trim() : null,
            dockerfile_path: mode === 'dockerfile' ? dockerfilePath.trim() : null,
            entrypoint: entrypoint.trim() || null,
            cpu: parsePosInt(cpu) ?? null,
            memory_gb: parsePosInt(memoryGb) ?? null,
            disk_gb: parsePosInt(diskGb) ?? null,
          },
        });
      } else {
        await create.mutateAsync({
          slug,
          name: name.trim(),
          ...(mode === 'image' ? { image: image.trim() } : { dockerfile_path: dockerfilePath.trim() }),
          entrypoint: entrypoint.trim() || undefined,
          cpu: parsePosInt(cpu),
          memory_gb: parsePosInt(memoryGb),
          disk_gb: parsePosInt(diskGb),
        });
      }
      haptics.success();
      onClose();
    } catch (e: any) {
      setErr(e?.message || 'Could not save template.');
    }
  };

  const ModeButton = ({ m, icon: Icon, title, sub }: { m: Mode; icon: LucideIcon; title: string; sub: string }) => {
    const active = mode === m;
    return (
      <TouchableOpacity
        onPress={() => { haptics.tap(); setMode(m); }}
        activeOpacity={0.8}
        style={{ flex: 1, borderRadius: 12, borderWidth: 1, borderColor: active ? theme.primary : border, backgroundColor: active ? theme.primaryLight : 'transparent', padding: 12, gap: 4 }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Icon size={15} color={active ? theme.primary : muted} />
          <Text style={{ fontSize: 13.5, fontFamily: 'Roobert-Medium', color: active ? fg : muted }}>{title}</Text>
        </View>
        <Text style={{ fontSize: 11.5, color: muted }}>{sub}</Text>
      </TouchableOpacity>
    );
  };

  return (
    <View style={{ flex: 1 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingTop: 4, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)' }}>
        <Container size={18} color={fg} />
        <Text style={{ flex: 1, fontSize: 17, fontFamily: 'Roobert-Medium', color: fg }} numberOfLines={1}>
          {isEdit ? `Edit "${template?.name}"` : 'New sandbox template'}
        </Text>
        <TouchableOpacity onPress={() => { haptics.tap(); onClose(); }} hitSlop={8} style={{ width: 30, height: 30, borderRadius: 15, backgroundColor: closeBg, alignItems: 'center', justifyContent: 'center' }}>
          <X size={17} color={muted} />
        </TouchableOpacity>
      </View>

      <BottomSheetScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16 }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        <Text style={{ fontSize: 12.5, color: muted, marginBottom: 16 }}>
          Pick a public Docker image or a Dockerfile in your repo. The Kortix runtime layer is added automatically.
        </Text>

        <View style={{ flexDirection: 'row', gap: 12 }}>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 11.5, fontFamily: 'Roobert-Medium', color: muted, marginBottom: 6 }}>Name</Text>
            <BottomSheetTextInput value={name} onChangeText={setName} placeholder="ML Development" placeholderTextColor={muted} style={input} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 11.5, fontFamily: 'Roobert-Medium', color: muted, marginBottom: 6 }}>Slug</Text>
            <BottomSheetTextInput
              value={slug}
              onChangeText={(t) => { setSlugEdited(true); setSlug(t.toLowerCase()); }}
              placeholder="ml"
              placeholderTextColor={muted}
              editable={!isEdit}
              autoCapitalize="none"
              autoCorrect={false}
              style={[input, { fontFamily: MONO, opacity: isEdit ? 0.6 : 1 }]}
            />
          </View>
        </View>
        {slugError && <Text style={{ fontSize: 11.5, color: '#ef4444', marginTop: 6 }}>{slugError}</Text>}

        <Text style={{ fontSize: 11.5, fontFamily: 'Roobert-Medium', color: muted, marginTop: 16, marginBottom: 8 }}>Image source</Text>
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <ModeButton m="image" icon={Package} title="Public image" sub="e.g. python:3.12-slim" />
          <ModeButton m="dockerfile" icon={FileCode} title="Dockerfile" sub="Path inside this repo" />
        </View>

        <View style={{ marginTop: 14 }}>
          {mode === 'image' ? (
            <>
              <Text style={{ fontSize: 11.5, fontFamily: 'Roobert-Medium', color: muted, marginBottom: 6 }}>Image</Text>
              <BottomSheetTextInput value={image} onChangeText={setImage} placeholder="python:3.12-slim" placeholderTextColor={muted} autoCapitalize="none" autoCorrect={false} style={[input, { fontFamily: MONO }]} />
              <Text style={{ fontSize: 11.5, color: muted, marginTop: 6 }}>Must include a specific tag (no latest).</Text>
            </>
          ) : (
            <>
              <Text style={{ fontSize: 11.5, fontFamily: 'Roobert-Medium', color: muted, marginBottom: 6 }}>Dockerfile path</Text>
              <BottomSheetTextInput value={dockerfilePath} onChangeText={setDockerfilePath} placeholder=".kortix/Dockerfile.ml" placeholderTextColor={muted} autoCapitalize="none" autoCorrect={false} style={[input, { fontFamily: MONO }]} />
              <Text style={{ fontSize: 11.5, color: muted, marginTop: 6 }}>Relative to the repository root.</Text>
            </>
          )}
          {sourceError && <Text style={{ fontSize: 11.5, color: '#ef4444', marginTop: 6 }}>{sourceError}</Text>}
        </View>

        <Text style={{ fontSize: 11.5, fontFamily: 'Roobert-Medium', color: muted, marginTop: 16, marginBottom: 8 }}>Resources</Text>
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <NumField label="vCPU" value={cpu} onChange={setCpu} isDark={isDark} />
          <NumField label="Memory (GiB)" value={memoryGb} onChange={setMemoryGb} isDark={isDark} />
          <NumField label="Disk (GiB)" value={diskGb} onChange={setDiskGb} isDark={isDark} />
        </View>

        <Text style={{ fontSize: 11.5, fontFamily: 'Roobert-Medium', color: muted, marginTop: 16, marginBottom: 6 }}>
          Entrypoint <Text style={{ color: muted, opacity: 0.7 }}>(optional)</Text>
        </Text>
        <BottomSheetTextInput
          value={entrypoint}
          onChangeText={setEntrypoint}
          placeholder="Leave blank to use the Kortix default (recommended)."
          placeholderTextColor={muted}
          multiline
          autoCapitalize="none"
          autoCorrect={false}
          style={[input, { height: 70, paddingTop: 10, fontFamily: MONO, fontSize: 12.5, textAlignVertical: 'top' }]}
        />

        {err && (
          <View style={{ marginTop: 14, padding: 12, borderRadius: 11, backgroundColor: 'rgba(239,68,68,0.08)', borderWidth: 1, borderColor: 'rgba(239,68,68,0.3)' }}>
            <Text style={{ fontSize: 13, color: '#ef4444' }}>{err}</Text>
          </View>
        )}
      </BottomSheetScrollView>

      <View style={{ padding: 16, paddingBottom: insets.bottom + 16, borderTopWidth: 1, borderTopColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)' }}>
        <TouchableOpacity onPress={handleSubmit} disabled={!canSubmit} activeOpacity={0.85} style={{ height: 48, borderRadius: 9999, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8, backgroundColor: theme.primary, opacity: canSubmit ? 1 : 0.5 }}>
          {submitting && <ActivityIndicator size="small" color={theme.primaryForeground} />}
          <Text style={{ fontSize: 15, fontFamily: 'Roobert-Medium', color: theme.primaryForeground }}>{isEdit ? 'Save changes' : 'Create template'}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ─── warm pool card ───────────────────────────────────────────────────────────

function WarmPoolCard({ project, projectId, canManage, isDark }: { project: KortixProject | undefined; projectId: string; canManage: boolean; isDark: boolean }) {
  const { colorScheme } = useColorScheme();
  const serverEnabled = project?.warm_pool?.enabled ?? true;
  const serverSize = project?.warm_pool?.size ?? 1;
  const [enabled, setEnabled] = useState(serverEnabled);
  const [size, setSize] = useState(serverSize);
  const save = useUpdateWarmPool(projectId);
  const status = useWarmPoolStatus(projectId, !!project?.warm_pool_available && enabled);

  useEffect(() => { setEnabled(serverEnabled); }, [serverEnabled]);
  useEffect(() => { setSize(serverSize); }, [serverSize]);

  const fg = isDark ? '#F8F8F8' : '#121215';
  const muted = isDark ? '#9b9b9b' : '#6e6e6e';
  const border = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';

  if (!project?.warm_pool_available) return null;

  const commit = (next: { enabled?: boolean; size?: number }) => {
    if (!canManage) return;
    save.mutate(next, {
      onError: (e: any) => {
        Alert.alert('Failed', e?.message || 'Could not update warm pool.');
        setEnabled(serverEnabled);
        setSize(serverSize);
      },
    });
  };
  const setSizeClamped = (n: number) => {
    const clamped = Math.max(0, Math.min(MAX_WARM, n));
    setSize(clamped);
    commit({ size: clamped });
  };

  return (
    <View style={{ marginTop: 24 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <Zap size={15} color={muted} />
        <SectionLabel color={muted}>Warm pool</SectionLabel>
      </View>
      <View style={{ borderRadius: 14, borderWidth: 1, borderColor: border, overflow: 'hidden' }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14 }}>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 14, fontFamily: 'Roobert-Medium', color: fg }}>Keep sandboxes warm</Text>
            <Text style={{ fontSize: 12, color: muted, marginTop: 3 }}>
              Pre-boot sandboxes while you're in the project so new sessions open instantly. Released automatically when you leave.
            </Text>
          </View>
          <Switch
            value={enabled}
            disabled={!canManage || save.isPending}
            onValueChange={(v) => { haptics.tap(); setEnabled(v); commit({ enabled: v }); }}
            trackColor={{ false: colorScheme === 'dark' ? '#3A3A3C' : '#E5E5E7', true: '#34C759' }}
            thumbColor="#FFFFFF"
            ios_backgroundColor={colorScheme === 'dark' ? '#3A3A3C' : '#E5E5E7'}
          />
        </View>

        {enabled && (
          <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12, padding: 14, borderTopWidth: 1, borderTopColor: border }}>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 14, fontFamily: 'Roobert-Medium', color: fg }}>Ready sandboxes</Text>
              <Text style={{ fontSize: 12, color: muted, marginTop: 3 }}>
                How many to keep warm and ready to claim (0–{MAX_WARM}). They use compute while running — the trade for instant sessions.
              </Text>
              {status.data && (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14, marginTop: 8 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: '#22c55e' }} />
                    <Text style={{ fontSize: 12, fontFamily: 'Roobert-Medium', color: '#16a34a' }}>{status.data.ready} ready</Text>
                  </View>
                  {status.data.warming > 0 && (
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: '#f59e0b' }} />
                      <Text style={{ fontSize: 12, color: muted }}>{status.data.warming} warming…</Text>
                    </View>
                  )}
                </View>
              )}
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <TouchableOpacity onPress={() => { haptics.tap(); setSizeClamped(size - 1); }} disabled={!canManage || save.isPending || size <= 0} style={{ width: 34, height: 34, borderRadius: 9, borderWidth: 1, borderColor: border, alignItems: 'center', justifyContent: 'center', opacity: size <= 0 ? 0.4 : 1 }}>
                <Minus size={16} color={fg} />
              </TouchableOpacity>
              <Text style={{ width: 26, textAlign: 'center', fontSize: 15, fontFamily: 'Roobert-Medium', color: fg }}>{size}</Text>
              <TouchableOpacity onPress={() => { haptics.tap(); setSizeClamped(size + 1); }} disabled={!canManage || save.isPending || size >= MAX_WARM} style={{ width: 34, height: 34, borderRadius: 9, borderWidth: 1, borderColor: border, alignItems: 'center', justifyContent: 'center', opacity: size >= MAX_WARM ? 0.4 : 1 }}>
                <Plus size={16} color={fg} />
              </TouchableOpacity>
            </View>
          </View>
        )}
      </View>
    </View>
  );
}

// ─── page ─────────────────────────────────────────────────────────────────────

export function SandboxPage({
  page,
  projectId,
  onOpenDrawer,
  onOpenRightDrawer,
  isDrawerOpen,
  isRightDrawerOpen,
  onOpenSession,
}: SandboxPageProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const theme = useThemeColors();
  const insets = useSafeAreaInsets();

  const projectQuery = useProject(projectId);
  const canManage = projectQuery.data?.effective_project_role === 'manager';
  const { data, isLoading, isError, error, refetch } = useProjectSnapshots(projectId);

  const buildMut = useBuildSandboxTemplate(projectId);
  const deleteMut = useDeleteSandboxTemplate(projectId);
  const rebuildMut = useRebuildSnapshot(projectId);
  const fixMut = useFixSandboxWithAgent(projectId);

  const [editing, setEditing] = useState<SandboxTemplate | null>(null);
  const [busyTemplate, setBusyTemplate] = useState<string | null>(null);
  const formSheetRef = React.useRef<BottomSheetModal>(null);

  const bgColor = isDark ? '#090909' : '#FFFFFF';
  const fg = isDark ? '#F8F8F8' : '#121215';
  const muted = isDark ? '#9b9b9b' : '#6e6e6e';
  const border = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';
  const cardBg = isDark ? 'rgba(255,255,255,0.02)' : 'rgba(0,0,0,0.015)';
  const codeBg = isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.04)';

  const builds = useMemo(() => (Array.isArray(data?.builds) ? data!.builds : []), [data]);
  const templates = useMemo(() => (Array.isArray(data?.templates) ? data!.templates : []), [data]);
  const latestFailure = useMemo(() => builds.find((b) => b.status === 'failed') ?? null, [builds]);
  const latestReady = useMemo(() => builds.find((b) => b.status === 'ready') ?? null, [builds]);
  const canFixWithAgent = !!latestFailure && !!latestReady;

  const openNew = () => {
    haptics.tap();
    setEditing(null);
    formSheetRef.current?.present();
  };
  const openEdit = (t: SandboxTemplate) => {
    setEditing(t);
    formSheetRef.current?.present();
  };
  const handleRebuildTemplate = (t: SandboxTemplate) => {
    if (!t.template_id) return;
    setBusyTemplate(t.template_id);
    buildMut.mutate(t.template_id, {
      onSuccess: () => haptics.success(),
      onError: (e: any) => Alert.alert('Failed', e?.message || 'Could not start build.'),
      onSettled: () => setBusyTemplate(null),
    });
  };
  const handleDeleteTemplate = (t: SandboxTemplate) => {
    if (!t.template_id) return;
    Alert.alert('Delete template', `Delete sandbox template "${t.name}"?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => {
        haptics.medium();
        setBusyTemplate(t.template_id!);
        deleteMut.mutate(t.template_id!, {
          onSuccess: () => haptics.success(),
          onError: (e: any) => Alert.alert('Failed', e?.message || 'Could not delete template.'),
          onSettled: () => setBusyTemplate(null),
        });
      } },
    ]);
  };
  const handleRetry = () => {
    haptics.tap();
    rebuildMut.mutate(latestFailure?.slug, {
      onSuccess: () => haptics.success(),
      onError: (e: any) => Alert.alert('Failed', e?.message || 'Could not start build.'),
    });
  };
  const handleFixWithAgent = () => {
    haptics.tap();
    fixMut.mutate(undefined, {
      onSuccess: (res) => { haptics.success(); onOpenSession?.(res.session_id); },
      onError: (e: any) => Alert.alert('Failed', e?.message || 'Could not start the fix session.'),
    });
  };

  return (
    <View style={{ flex: 1, backgroundColor: bgColor }}>
      <PageHeader
        title={page.label}
        onOpenDrawer={onOpenDrawer}
        onOpenRightDrawer={onOpenRightDrawer}
        isDrawerOpen={isDrawerOpen}
        isRightDrawerOpen={isRightDrawerOpen}
        rightActions={canManage ? (
          <TouchableOpacity onPress={openNew} hitSlop={10} style={{ width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.05)' }}>
            <Plus size={18} color={fg} />
          </TouchableOpacity>
        ) : undefined}
      />

      <PageContent>
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 48 }} showsVerticalScrollIndicator={false}>
          <Text style={{ fontSize: 12.5, color: muted, marginBottom: 16 }}>
            Sessions boot from a sandbox template. The platform default is shared by every project and clones your repo into{' '}
            <Text style={{ fontFamily: MONO }}>/workspace</Text> at boot. Add your own here or via{' '}
            <Text style={{ fontFamily: MONO }}>[[sandbox.templates]]</Text> in <Text style={{ fontFamily: MONO }}>kortix.toml</Text>.
          </Text>

          {isLoading ? (
            <View style={{ paddingVertical: 48, alignItems: 'center' }}><ActivityIndicator size="small" color={muted} /></View>
          ) : isError ? (
            <View style={{ padding: 20, borderRadius: 14, borderWidth: 1, borderColor: 'rgba(239,68,68,0.3)', backgroundColor: 'rgba(239,68,68,0.05)', gap: 12 }}>
              <Text style={{ fontSize: 13.5, color: '#ef4444' }}>Failed to load sandbox templates: {(error as Error)?.message}</Text>
              <TouchableOpacity onPress={() => refetch()} style={{ alignSelf: 'flex-start', paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, borderWidth: 1, borderColor: border }}>
                <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: fg }}>Retry</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <>
              {data?.templates_error && (
                <View style={{ marginBottom: 14, padding: 12, borderRadius: 11, backgroundColor: 'rgba(217,119,6,0.08)' }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <TriangleAlert size={14} color="#d97706" />
                    <Text style={{ fontSize: 12.5, color: '#d97706', flex: 1 }}>Couldn't read project sandbox config: {data.templates_error}</Text>
                  </View>
                </View>
              )}

              {/* Templates */}
              <SectionLabel color={muted}>Sandbox templates</SectionLabel>
              {templates.length === 0 ? (
                <View style={{ borderRadius: 14, borderWidth: 1, borderStyle: 'dashed', borderColor: border, paddingVertical: 28, alignItems: 'center' }}>
                  <Text style={{ fontSize: 13.5, color: muted }}>No templates resolved yet.</Text>
                </View>
              ) : (
                <View style={{ borderRadius: 14, borderWidth: 1, borderColor: border, backgroundColor: cardBg, overflow: 'hidden' }}>
                  {templates.map((t, i) => (
                    <TemplateRow
                      key={t.template_id ?? `tpl-${t.slug}`}
                      template={t}
                      canManage={canManage}
                      isDark={isDark}
                      isLast={i === templates.length - 1}
                      onEdit={openEdit}
                      onDelete={handleDeleteTemplate}
                      onRebuild={handleRebuildTemplate}
                      rebuilding={busyTemplate === t.template_id && buildMut.isPending}
                      deleting={busyTemplate === t.template_id && deleteMut.isPending}
                    />
                  ))}
                </View>
              )}

              {/* Latest failure */}
              {latestFailure && (
                <View style={{ marginTop: 20, borderRadius: 14, borderWidth: 1, borderColor: 'rgba(239,68,68,0.3)', backgroundColor: 'rgba(239,68,68,0.05)', padding: 14 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <CircleX size={15} color="#ef4444" />
                    <Text style={{ fontSize: 13.5, fontFamily: 'Roobert-Medium', color: '#ef4444' }}>Latest build failed</Text>
                    {latestFailure.error_category && (
                      <View style={{ paddingHorizontal: 7, paddingVertical: 2, borderRadius: 999, backgroundColor: 'rgba(239,68,68,0.12)' }}>
                        <Text style={{ fontSize: 11, fontFamily: 'Roobert-Medium', color: '#ef4444' }}>{CATEGORY_LABEL[latestFailure.error_category] ?? latestFailure.error_category}</Text>
                      </View>
                    )}
                  </View>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6 }}>
                    <View style={{ paddingHorizontal: 6, paddingVertical: 1.5, borderRadius: 5, backgroundColor: codeBg }}>
                      <Text style={{ fontSize: 11, fontFamily: MONO, color: muted }}>{latestFailure.slug}</Text>
                    </View>
                    <Text style={{ fontSize: 11.5, color: muted }}>{formatRelative(latestFailure.finished_at ?? latestFailure.started_at)}</Text>
                  </View>
                  {latestFailure.error && (
                    <ScrollView style={{ maxHeight: 140, marginTop: 10, borderRadius: 9, backgroundColor: isDark ? 'rgba(0,0,0,0.3)' : 'rgba(0,0,0,0.04)' }} contentContainerStyle={{ padding: 10 }} showsVerticalScrollIndicator={false}>
                      <Text style={{ fontSize: 11.5, lineHeight: 17, fontFamily: MONO, color: muted }}>{latestFailure.error}</Text>
                    </ScrollView>
                  )}
                  {canManage && (
                    <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
                      <TouchableOpacity onPress={handleRetry} disabled={rebuildMut.isPending} activeOpacity={0.7} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, height: 38, borderRadius: 999, borderWidth: 1, borderColor: border }}>
                        {rebuildMut.isPending ? <ActivityIndicator size="small" color={fg} /> : <RefreshCw size={14} color={fg} />}
                        <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: fg }}>Retry build</Text>
                      </TouchableOpacity>
                      {canFixWithAgent && (
                        <TouchableOpacity onPress={handleFixWithAgent} disabled={fixMut.isPending} activeOpacity={0.85} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, height: 38, borderRadius: 999, backgroundColor: theme.primary }}>
                          {fixMut.isPending ? <ActivityIndicator size="small" color={theme.primaryForeground} /> : <Sparkles size={14} color={theme.primaryForeground} />}
                          <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: theme.primaryForeground }}>Fix with agent</Text>
                        </TouchableOpacity>
                      )}
                    </View>
                  )}
                </View>
              )}

              {/* Recent builds */}
              <View style={{ marginTop: 24 }}>
                <SectionLabel color={muted}>Recent builds</SectionLabel>
                {builds.length === 0 ? (
                  <View style={{ borderRadius: 14, borderWidth: 1, borderStyle: 'dashed', borderColor: border, paddingVertical: 24, paddingHorizontal: 16, alignItems: 'center' }}>
                    <Text style={{ fontSize: 12.5, color: muted, textAlign: 'center' }}>No builds recorded yet. The platform default builds once globally; custom templates build on first use.</Text>
                  </View>
                ) : (
                  <View style={{ borderRadius: 14, borderWidth: 1, borderColor: border, backgroundColor: cardBg, overflow: 'hidden' }}>
                    {builds.slice(0, 10).map((b: ProjectSnapshotBuild, i) => (
                      <View key={b.build_id} style={{ paddingHorizontal: 14, paddingVertical: 11, borderBottomWidth: i === Math.min(builds.length, 10) - 1 ? 0 : 1, borderBottomColor: border }}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                          <View style={{ paddingHorizontal: 6, paddingVertical: 1.5, borderRadius: 5, backgroundColor: codeBg }}>
                            <Text style={{ fontSize: 11, fontFamily: MONO, color: muted }}>{b.slug}</Text>
                          </View>
                          <StatusPill status={b.status} />
                          {b.source && <Text style={{ fontSize: 11.5, color: muted }}>via {b.source}</Text>}
                          <Text style={{ marginLeft: 'auto', fontSize: 11.5, color: muted }}>{formatRelative(b.finished_at ?? b.started_at)}</Text>
                        </View>
                        {b.status === 'failed' && b.error && (
                          <View style={{ marginTop: 8, borderRadius: 8, backgroundColor: 'rgba(239,68,68,0.06)', padding: 8 }}>
                            <Text style={{ fontSize: 11, lineHeight: 16, fontFamily: MONO, color: '#ef4444' }} numberOfLines={6}>{b.error}</Text>
                          </View>
                        )}
                      </View>
                    ))}
                  </View>
                )}
              </View>

              {/* Warm pool */}
              <WarmPoolCard project={projectQuery.data} projectId={projectId} canManage={canManage} isDark={isDark} />
            </>
          )}
        </ScrollView>
      </PageContent>

      <BottomSheetModal
        ref={formSheetRef}
        snapPoints={['92%']}
        enableDynamicSizing={false}
        onDismiss={() => setEditing(null)}
        backgroundStyle={{ backgroundColor: getSheetBg(isDark) }}
        handleIndicatorStyle={{ backgroundColor: isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.2)' }}
        keyboardBehavior="interactive"
        keyboardBlurBehavior="restore"
        backdropComponent={(props) => <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} opacity={0.5} />}
      >
        <SandboxTemplateSheet projectId={projectId} template={editing} onClose={() => formSheetRef.current?.dismiss()} isDark={isDark} />
      </BottomSheetModal>
    </View>
  );
}
