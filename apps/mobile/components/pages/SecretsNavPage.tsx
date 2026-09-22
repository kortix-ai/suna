/**
 * SecretsNavPage — the project's secrets (web parity:
 * customize/sections/secrets-view). Each KEY has a shared (project-wide) value
 * that managers control and an optional per-member personal override. Values
 * are write-only — never returned by the API; "is set" is conveyed via text.
 *
 * Mobile branding: PageHeader + PageContent chrome, bottom sheets for add /
 * detail / shared & personal value forms, design-system typography + colors.
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
  KeyIcon as Key,
  UserIcon as User,
  LockIcon as Lock,
  UsersIcon as Users,
  GlobeIcon as Globe,
  CheckIcon as Check,
  CaretRightIcon as ChevronRight,
  TrashIcon as Trash2,
  XIcon as X,
  ShieldWarningIcon as ShieldAlert,
  type AppIcon,
} from '@/lib/icons';
import { Text } from '@/components/ui/text';
import { PageHeader } from '@/components/kortix/page-header';
import { PageContent } from '@/components/kortix/page-content';
import { SearchListHeader } from '@/components/kortix/search-list-header';
import Animated from 'react-native-reanimated';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { SheetTextInput } from '@/components/kortix/SheetInput';
import { POP_IN, PUSH_IN, SheetBackButton } from '@/components/kortix/sheet-push';
import { Icon } from '@/components/ui/icon';
import { PageList } from '@/components/kortix/page-list';
import { SettingsGroup, SettingsRow } from '@/components/kortix/settings-list';
import { useThemeColors } from '@/lib/theme-colors';
import { THEME, withAlpha } from '@/lib/utils/theme';
import {
  useProjectSecrets,
  useUpsertProjectSecret,
  useDeleteProjectSecret,
  useSetPersonalProjectSecret,
  useDeletePersonalProjectSecret,
  useProjectAccess,
} from '@/lib/projects/hooks';
import type { ProjectSecret, ConnectorSharing } from '@/lib/projects/projects-client';
import { haptics } from '@/lib/haptics';
import { KortixBottomSheetModal, SheetTitleRow } from '@/components/kortix/sheet';

interface PageTabLike {
  id: string;
  label: string;
}

interface SecretsNavPageProps {
  page: PageTabLike;
  projectId: string;
  onOpenDrawer?: () => void;
  onOpenRightDrawer?: () => void;
  isDrawerOpen?: boolean;
  isRightDrawerOpen?: boolean;
}

const MONO = 'Menlo';
const SECRET_NAME_RE = /^[A-Z_][A-Z0-9_]{0,63}$/;
const sanitizeName = (t: string) => t.toUpperCase().replace(/[^A-Z0-9_]/g, '');

/**
 * `usable_by_me` and `sharing` are legacy per-secret sharing fields the
 * current `ProjectSecret` SDK type no longer declares — its own doc comment
 * says every project member with read access sees every secret now, with no
 * per-secret member/group sharing. Read them defensively rather than widen
 * the SDK contract from this app.
 */
type SecretWithLegacySharing = ProjectSecret & {
  usable_by_me?: boolean;
  sharing?: ConnectorSharing | null;
};

interface Row {
  name: string;
  secret: SecretWithLegacySharing | null;
  required: boolean;
  optional: boolean;
}

function buildRows(
  items: ProjectSecret[],
  required: string[],
  optional: string[],
): Row[] {
  const byName = new Map(items.map((s) => [s.name, s]));
  const used = new Set<string>();
  const rows: Row[] = [];
  for (const name of required) {
    rows.push({ name, secret: byName.get(name) ?? null, required: true, optional: false });
    used.add(name);
  }
  for (const name of optional) {
    if (used.has(name)) continue;
    rows.push({ name, secret: byName.get(name) ?? null, required: false, optional: true });
    used.add(name);
  }
  for (const s of items) {
    if (used.has(s.name)) continue;
    rows.push({ name: s.name, secret: s, required: false, optional: false });
  }
  return rows;
}

function statusText(s: SecretWithLegacySharing | null): string {
  if (!s) return 'Not set';
  if (s.effective_source === 'mine') return 'Using your own value';
  if (s.effective_source === 'shared') return 'Using the shared value';
  if (s.configured && !s.usable_by_me) return "Shared exists, not shared with you";
  return 'Not set';
}

function sharingScopeLabel(sharing: ConnectorSharing | null | undefined): string | null {
  if (!sharing || sharing.mode === 'project') return null;
  if (sharing.mode === 'private') return 'Owner only';
  return 'Select members';
}

// ─── Sharing field (project / private / members) ──────────────────────────────

const SHARE_OPTIONS: { mode: 'project' | 'private' | 'members'; label: string; icon: AppIcon }[] = [
  { mode: 'project', label: 'Everyone', icon: Globe },
  { mode: 'private', label: 'Only me', icon: Lock },
  { mode: 'members', label: 'Members', icon: Users },
];

function SharingField({
  projectId,
  value,
  onChange,
  isDark,
}: {
  projectId: string;
  value: ConnectorSharing;
  onChange: (v: ConnectorSharing) => void;
  isDark: boolean;
}) {
  const theme = useThemeColors();
  const access = useProjectAccess(value.mode === 'members' ? projectId : null);
  const fg = isDark ? THEME.dark.foreground : THEME.light.foreground;
  const muted = isDark ? THEME.dark.mutedForeground : THEME.light.mutedForeground;
  const border = isDark ? withAlpha(THEME.dark.foreground, 0.1) : withAlpha(THEME.light.foreground, 0.1);

  const memberIds = value.mode === 'members' ? (value.memberIds ?? []) : [];
  const selectedSet = useMemo(() => new Set(memberIds), [memberIds]);
  const members = access.data?.members ?? [];

  const toggleMember = (id: string) => {
    const next = selectedSet.has(id) ? memberIds.filter((x) => x !== id) : [...memberIds, id];
    onChange({ mode: 'members', memberIds: next });
  };

  return (
    <View>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        {SHARE_OPTIONS.map((opt) => {
          const on = value.mode === opt.mode;
          const Icon = opt.icon;
          return (
            <Pressable
              key={opt.mode}
              onPress={() => {
                haptics.selection();
                if (opt.mode === 'project') onChange({ mode: 'project' });
                else if (opt.mode === 'private') onChange({ mode: 'private', ownerId: '' });
                else onChange({ mode: 'members', memberIds });
              }}
              style={{
                flex: 1, alignItems: 'center', gap: 5, paddingVertical: 11, borderRadius: 12,
                borderWidth: 1.5, borderColor: on ? theme.primary : border,
                backgroundColor: on ? theme.primaryLight : 'transparent',
              }}
            >
              <Icon size={17} color={on ? theme.primary : muted} />
              <Text style={{ fontSize: 12, fontFamily: 'Roobert-Medium', color: on ? theme.primary : muted }}>{opt.label}</Text>
            </Pressable>
          );
        })}
      </View>

      {value.mode === 'members' && (
        <View style={{ marginTop: 10, borderRadius: 12, borderWidth: 1, borderColor: border, overflow: 'hidden' }}>
          {access.isLoading ? (
            <View style={{ padding: 18, alignItems: 'center' }}><ActivityIndicator size="small" color={muted} /></View>
          ) : members.length === 0 ? (
            <View style={{ padding: 18, alignItems: 'center' }}><Text style={{ fontSize: 13, color: muted }}>No members.</Text></View>
          ) : (
            members.map((m, i) => {
              const on = selectedSet.has(m.user_id);
              return (
                <Pressable
                  key={m.user_id}
                  onPress={() => { haptics.selection(); toggleMember(m.user_id); }}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingVertical: 10, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: border }}
                >
                  <View style={{ width: 26, height: 26, borderRadius: 13, backgroundColor: theme.primaryLight, alignItems: 'center', justifyContent: 'center' }}>
                    <Text style={{ fontSize: 11, fontFamily: 'Roobert-Medium', color: theme.primary }}>{(m.email ?? m.user_id).charAt(0).toUpperCase()}</Text>
                  </View>
                  <Text style={{ flex: 1, fontSize: 13.5, color: fg }} numberOfLines={1}>{m.email ?? m.user_id}</Text>
                  <View style={{ width: 20, height: 20, borderRadius: 6, borderWidth: on ? 0 : 1.5, borderColor: border, backgroundColor: on ? theme.primary : 'transparent', alignItems: 'center', justifyContent: 'center' }}>
                    {on && <Check size={13} color={theme.primaryForeground} />}
                  </View>
                </Pressable>
              );
            })
          )}
        </View>
      )}
    </View>
  );
}

// ─── Shared value form ────────────────────────────────────────────────────────

/** `Input`'s geometry (44pt, `rounded-xl`) on the sheet's text field. */
const FIELD_STYLE = { height: 44, borderRadius: 12, paddingHorizontal: 14 } as const;

function SharedSecretForm({
  projectId,
  initialName,
  nameEditable,
  configured,
  initialSharing,
  onClose,
  pushed,
  isDark,
}: {
  projectId: string;
  initialName: string;
  nameEditable: boolean;
  configured: boolean;
  initialSharing: ConnectorSharing;
  onClose: () => void;
  /** Shown inside the detail sheet: Back takes the close button's slot. */
  pushed?: boolean;
  isDark: boolean;
}) {
  const theme = useThemeColors();
  const insets = useSafeAreaInsets();
  const upsert = useUpsertProjectSecret(projectId);

  const [name, setName] = useState(initialName);
  const [value, setValue] = useState('');
  const [sharing, setSharing] = useState<ConnectorSharing>(initialSharing);

  const fg = isDark ? THEME.dark.foreground : THEME.light.foreground;
  const muted = isDark ? THEME.dark.mutedForeground : THEME.light.mutedForeground;
  const border = isDark ? withAlpha(THEME.dark.foreground, 0.1) : withAlpha(THEME.light.foreground, 0.12);
  const inputBg = isDark ? withAlpha(THEME.dark.foreground, 0.05) : withAlpha(THEME.light.foreground, 0.03);

  const nameValid = SECRET_NAME_RE.test(name) && !name.startsWith('KORTIX_');
  const requiresValue = !configured;
  const canSave =
    nameValid && (!requiresValue || value.trim().length > 0) && !upsert.isPending;

  const handleSave = () => {
    if (!canSave) return;
    haptics.tap();
    upsert.mutate(
      { name, ...(value.trim() ? { value } : {}), sharing },
      {
        onSuccess: onClose,
        onError: (err: any) => Alert.alert('Save failed', err?.message || 'Could not save secret.'),
      },
    );
  };

  return (
    <View style={{ flex: 1 }}>
      <SheetTitleRow title={nameEditable ? 'Add a secret' : configured ? 'Edit shared value' : 'Set shared value'} onClose={() => { haptics.tap(); onClose(); }} leading={pushed ? <SheetBackButton onPress={() => { haptics.tap(); onClose(); }} /> : undefined} />

      <BottomSheetScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 4, paddingBottom: 16, gap: 8 }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        <Label>Name</Label>
        <SheetTextInput mono
          value={name}
          onChangeText={(t) => setName(sanitizeName(t))}
          editable={nameEditable}
          placeholder="STRIPE_API_KEY"
          autoCapitalize="characters"
          autoCorrect={false}
          style={FIELD_STYLE}
        />
        {nameEditable && name.length > 0 && !nameValid && (
          <Text style={{ fontSize: 12, color: (isDark ? THEME.dark.destructive : THEME.light.destructive), marginBottom: 8 }}>
            Use A–Z, 0–9 and _, starting with a letter. KORTIX_ is reserved.
          </Text>
        )}

        <Label>
          {configured ? 'New value' : 'Value'}
        </Label>
        <SheetTextInput
          value={value}
          onChangeText={setValue}
          placeholder={configured ? 'Leave blank to keep current' : 'Paste the secret value…'}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          style={FIELD_STYLE}
        />
        <Text variant="muted">Encrypted at rest and never shown again.</Text>

        <Label>Who can use it</Label>
        <SharingField projectId={projectId} value={sharing} onChange={setSharing} isDark={isDark} />
      </BottomSheetScrollView>

      {/* Pinned under the form: always reachable above the keyboard. */}
      <View className="px-4 pt-3" style={{ paddingBottom: insets.bottom + 16 }}>
        <Button size="lg" className="rounded-full" onPress={handleSave} disabled={!canSave}>
          <Text>{upsert.isPending ? 'Saving…' : 'Save shared value'}</Text>
        </Button>
      </View>
    </View>
  );
}

// ─── Personal value form ──────────────────────────────────────────────────────

function PersonalSecretForm({
  projectId,
  initialName,
  nameEditable,
  onClose,
  pushed,
  isDark,
}: {
  projectId: string;
  initialName: string;
  nameEditable: boolean;
  onClose: () => void;
  /** Shown inside the detail sheet: Back takes the close button's slot. */
  pushed?: boolean;
  isDark: boolean;
}) {
  const theme = useThemeColors();
  const insets = useSafeAreaInsets();
  const setPersonal = useSetPersonalProjectSecret(projectId);

  const [name, setName] = useState(initialName);
  const [value, setValue] = useState('');

  const fg = isDark ? THEME.dark.foreground : THEME.light.foreground;
  const muted = isDark ? THEME.dark.mutedForeground : THEME.light.mutedForeground;
  const border = isDark ? withAlpha(THEME.dark.foreground, 0.1) : withAlpha(THEME.light.foreground, 0.12);
  const inputBg = isDark ? withAlpha(THEME.dark.foreground, 0.05) : withAlpha(THEME.light.foreground, 0.03);

  const nameValid = SECRET_NAME_RE.test(name) && !name.startsWith('KORTIX_');
  const canSave = nameValid && value.trim().length > 0 && !setPersonal.isPending;

  const handleSave = () => {
    if (!canSave) return;
    haptics.tap();
    setPersonal.mutate(
      { name, value, active: true },
      {
        onSuccess: onClose,
        onError: (err: any) => Alert.alert('Save failed', err?.message || 'Could not save your value.'),
      },
    );
  };

  return (
    <View style={{ flex: 1 }}>
      <SheetTitleRow title={nameEditable ? 'Add your value' : 'Your value'} onClose={() => { haptics.tap(); onClose(); }} leading={pushed ? <SheetBackButton onPress={() => { haptics.tap(); onClose(); }} /> : undefined} />

      <BottomSheetScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 4, paddingBottom: 16, gap: 8 }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        <Label>Name</Label>
        <SheetTextInput mono
          value={name}
          onChangeText={(t) => setName(sanitizeName(t))}
          editable={nameEditable}
          placeholder="STRIPE_API_KEY"
          autoCapitalize="characters"
          autoCorrect={false}
          style={FIELD_STYLE}
        />

        <Label>Your value</Label>
        <SheetTextInput
          value={value}
          onChangeText={setValue}
          placeholder="Paste your value…"
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          style={FIELD_STYLE}
        />
        <Text variant="muted">
          Only used in your own sessions. Other members never see it.
        </Text>
      </BottomSheetScrollView>

      {/* Pinned under the form: always reachable above the keyboard. */}
      <View className="px-4 pt-3" style={{ paddingBottom: insets.bottom + 16 }}>
        <Button size="lg" className="rounded-full" onPress={handleSave} disabled={!canSave}>
          <Text>{setPersonal.isPending ? 'Saving…' : 'Use my own value'}</Text>
        </Button>
      </View>
    </View>
  );
}

// ─── Secret detail sheet (status · source · actions) ──────────────────────────

function ActionRow({
  label,
  destructive,
  onPress,
  isDark,
  busy,
}: {
  label: string;
  destructive?: boolean;
  onPress: () => void;
  isDark: boolean;
  busy?: boolean;
}) {
  const fg = isDark ? THEME.dark.foreground : THEME.light.foreground;
  const border = isDark ? withAlpha(THEME.dark.foreground, 0.08) : withAlpha(THEME.light.foreground, 0.08);
  const color = destructive ? (isDark ? THEME.dark.destructive : THEME.light.destructive) : fg;
  return (
    <Pressable
      onPress={onPress}
      disabled={busy}
      style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: border, opacity: busy ? 0.5 : 1 }}
    >
      {destructive && <Trash2 size={16} color={color} style={{ marginRight: 10 }} />}
      <Text style={{ flex: 1, fontSize: 15, fontFamily: 'Roobert-Medium', color }}>{label}</Text>
      {busy ? <ActivityIndicator size="small" color={color} /> : !destructive && <ChevronRight size={18} color={isDark ? THEME.dark.mutedForeground : THEME.light.mutedForeground} />}
    </Pressable>
  );
}

function SecretDetailSheet({
  projectId,
  row,
  canManage,
  onClose,
  isDark,
}: {
  projectId: string;
  row: Row;
  canManage: boolean;
  onClose: () => void;
  isDark: boolean;
}) {
  const theme = useThemeColors();
  const insets = useSafeAreaInsets();
  const [view, setView] = useState<'detail' | 'shared' | 'personal'>('detail');
  // The detail slides back in only after a form was open, never on first open.
  const [returning, setReturning] = useState(false);
  const back = () => {
    setReturning(true);
    setView('detail');
  };
  const setPersonal = useSetPersonalProjectSecret(projectId);
  const deletePersonal = useDeletePersonalProjectSecret(projectId);
  const deleteShared = useDeleteProjectSecret(projectId);

  const s = row.secret;
  const fg = isDark ? THEME.dark.foreground : THEME.light.foreground;
  const muted = isDark ? THEME.dark.mutedForeground : THEME.light.mutedForeground;
  const border = isDark ? withAlpha(THEME.dark.foreground, 0.08) : withAlpha(THEME.light.foreground, 0.08);
  const iconBg = isDark ? withAlpha(THEME.dark.foreground, 0.06) : withAlpha(THEME.light.foreground, 0.04);
  const closeBg = isDark ? withAlpha(THEME.dark.foreground, 0.05) : withAlpha(THEME.light.foreground, 0.04);

  const canManageShared = canManage || !!s?.can_manage_shared;
  const sharedSelectable = !!s?.configured && !!s?.usable_by_me;
  const mineActive = s?.effective_source === 'mine';
  const scope = sharingScopeLabel(s?.sharing);

  const chooseShared = () => {
    if (!sharedSelectable) return;
    if (s?.mine) {
      haptics.selection();
      setPersonal.mutate({ name: row.name, active: false });
    }
  };
  const chooseMine = () => {
    if (s?.mine) {
      haptics.selection();
      if (!mineActive) setPersonal.mutate({ name: row.name, active: true });
    } else {
      setView('personal');
    }
  };

  const confirmRemovePersonal = () => {
    Alert.alert('Remove your value', `Remove your personal value for ${row.name}?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove', style: 'destructive', onPress: () => {
          haptics.medium();
          deletePersonal.mutate(row.name, { onError: (e: any) => Alert.alert('Failed', e?.message || 'Could not remove.') });
        },
      },
    ]);
  };
  const confirmDeleteShared = () => {
    Alert.alert('Delete shared value', `Delete the shared value for ${row.name}? Members' own values stay.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive', onPress: () => {
          haptics.medium();
          deleteShared.mutate(row.name, { onError: (e: any) => Alert.alert('Failed', e?.message || 'Could not delete.') });
        },
      },
    ]);
  };

  // A value form pushes in over the detail, the activity sheet's motion
  // (`sheet-push`): in from the right, and the detail back in from the left.
  if (view !== 'detail') {
    return (
      <Animated.View key={view} entering={PUSH_IN} style={{ flex: 1 }}>
        {view === 'shared' ? (
          <SharedSecretForm
            projectId={projectId}
            initialName={row.name}
            nameEditable={false}
            configured={!!s?.configured}
            initialSharing={s?.sharing ?? { mode: 'project' }}
            onClose={back}
            pushed
            isDark={isDark}
          />
        ) : (
          <PersonalSecretForm
            projectId={projectId}
            initialName={row.name}
            nameEditable={false}
            onClose={back}
            pushed
            isDark={isDark}
          />
        )}
      </Animated.View>
    );
  }

  return (
    <Animated.View key="detail" entering={returning ? POP_IN : undefined} style={{ flex: 1 }}>
      <SheetTitleRow title={row.name} onClose={() => { haptics.tap(); onClose(); }} />

      <BottomSheetScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 4, paddingBottom: insets.bottom + 32, gap: 16 }}
        showsVerticalScrollIndicator={false}>
        {/* Which value my sessions use: only when there is a choice to make. */}
        {s?.mine || sharedSelectable ? (
          <SettingsGroup title="Use in my sessions" className="bg-secondary">
            <SettingsRow
              icon={Users}
              label="Shared value"
              checked={s?.effective_source === 'shared'}
              right={null}
              onPress={sharedSelectable ? chooseShared : undefined}
            />
            <SettingsRow icon={User} label="My value" checked={mineActive} right={null} onPress={chooseMine} />
          </SettingsGroup>
        ) : null}

        <SettingsGroup title="My value" className="bg-secondary">
          <SettingsRow
            label={s?.mine ? 'Edit my value' : 'Set my value'}
            onPress={() => { haptics.tap(); setView('personal'); }}
          />
          {s?.mine ? (
            <SettingsRow
              label={deletePersonal.isPending ? 'Removing…' : 'Remove my value'}
              destructive
              right={null}
              onPress={deletePersonal.isPending ? undefined : confirmRemovePersonal}
            />
          ) : null}
        </SettingsGroup>

        {canManageShared ? (
          <SettingsGroup title={scope ? `Shared value · ${scope}` : 'Shared value'} className="bg-secondary">
            <SettingsRow
              label={s?.configured ? 'Edit shared value' : 'Set shared value'}
              onPress={() => { haptics.tap(); setView('shared'); }}
            />
            {s?.configured ? (
              <SettingsRow
                label={deleteShared.isPending ? 'Deleting…' : 'Delete shared value'}
                destructive
                right={null}
                onPress={deleteShared.isPending ? undefined : confirmDeleteShared}
              />
            ) : null}
          </SettingsGroup>
        ) : null}
      </BottomSheetScrollView>
    </Animated.View>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

function ManifestBanner({ status, path, error, isDark }: { status?: string; path?: string; error?: string; isDark: boolean }) {
  const muted = isDark ? THEME.dark.mutedForeground : THEME.light.mutedForeground;
  if (!status || status === 'loaded') return null;
  const warn = status === 'error';
  const color = warn ? THEME.accent.orange : muted;
  const bg = warn ? withAlpha(THEME.accent.orange, 0.08) : (isDark ? withAlpha(THEME.dark.foreground, 0.04) : withAlpha(THEME.light.foreground, 0.03));
  const text =
    status === 'missing'
      ? 'No kortix.yaml manifest — declare required env keys to track them here.'
      : error || 'Manifest could not be read.';
  return (
    <View style={{ marginHorizontal: 16, marginTop: 12, padding: 12, borderRadius: 12, backgroundColor: bg, flexDirection: 'row', gap: 10, alignItems: 'flex-start' }}>
      <ShieldAlert size={16} color={color} style={{ marginTop: 1 }} />
      <Text style={{ flex: 1, fontSize: 12.5, lineHeight: 17, color }}>{text}{path ? ` (${path})` : ''}</Text>
    </View>
  );
}

export function SecretsNavPage({
  page,
  projectId,
  onOpenDrawer,
  onOpenRightDrawer,
  isDrawerOpen,
  isRightDrawerOpen,
}: SecretsNavPageProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const insets = useSafeAreaInsets();
  const [search, setSearch] = useState('');
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const addSheetRef = React.useRef<BottomSheetModal>(null);
  const detailSheetRef = React.useRef<BottomSheetModal>(null);

  const { data, isLoading, isError, error, refetch } = useProjectSecrets(projectId);

  const bgColor = isDark ? THEME.dark.background : THEME.light.background;
  const fg = isDark ? THEME.dark.foreground : THEME.light.foreground;
  const muted = isDark ? THEME.dark.mutedForeground : THEME.light.mutedForeground;
  const border = isDark ? withAlpha(THEME.dark.foreground, 0.08) : withAlpha(THEME.light.foreground, 0.08);

  const canManage = !!data?.can_manage;
  const rows = useMemo(
    () => buildRows(data?.items ?? [], data?.required ?? [], data?.optional ?? []),
    [data],
  );
  const filtered = useMemo(() => {
    const q = search.trim().toUpperCase();
    return q ? rows.filter((r) => r.name.includes(q)) : rows;
  }, [rows, search]);

  const missingRequired = useMemo(
    () => rows.filter((r) => r.required && (r.secret?.effective_source ?? 'none') === 'none').length,
    [rows],
  );

  const selectedRow = useMemo(
    () => rows.find((r) => r.name === selectedName) ?? null,
    [rows, selectedName],
  );

  const openRow = (name: string) => {
    haptics.tap();
    setSelectedName(name);
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
        addLabel="New secret"
      />

      <PageContent>
        <ManifestBanner status={data?.manifest_status} path={data?.manifest_path} error={data?.manifest_error} isDark={isDark} />

        {missingRequired > 0 && (
          <View style={{ marginHorizontal: 16, marginTop: 12, padding: 12, borderRadius: 12, backgroundColor: withAlpha(THEME.accent.orange, 0.08), flexDirection: 'row', gap: 10, alignItems: 'center' }}>
            <ShieldAlert size={16} color={THEME.accent.orange} />
            <Text style={{ flex: 1, fontSize: 12.5, color: THEME.accent.orange }}>
              {missingRequired} required {missingRequired === 1 ? 'secret is' : 'secrets are'} not set.
            </Text>
          </View>
        )}

        <SearchListHeader
          value={search}
          onChangeText={setSearch}
          placeholder="Search secrets"
        />

        <PageList
          isLoading={isLoading}
          errorMessage={isError && rows.length === 0 ? ((error as Error)?.message ?? 'Unable to load secrets') : null}
          onRetry={() => void refetch()}
          onRefresh={() => refetch()}
          emptyLabel={filtered.length === 0 ? (rows.length === 0 ? 'No secrets yet' : 'No matching secrets') : null}>
          {/* Settings rows in a group (Jay, 2026-09-22), the Agents list's layout. */}
          <View className="px-4 pt-1">
            <SettingsGroup>
              {filtered.map((row) => {
                const s = row.secret;
                const scope = sharingScopeLabel(s?.sharing);
                const need = row.required ? 'Required' : row.optional ? 'Optional' : null;
                return (
                  <SettingsRow
                    key={row.name}
                    label={row.name}
                    description={[need, statusText(s), scope].filter(Boolean).join(' · ')}
                    onPress={() => openRow(row.name)}
                    right={
                      <View className="flex-row items-center gap-3">
                        {/* A required secret with no value: the one state that blocks a run. */}
                        {row.required && (s?.effective_source ?? 'none') === 'none' ? (
                          <View accessibilityLabel="Not set" className="size-1.5 rounded-full bg-kortix-orange" />
                        ) : null}
                        <Icon as={ChevronRight} size={16} className="text-muted-foreground/70" />
                      </View>
                    }
                  />
                );
              })}
            </SettingsGroup>
          </View>
        </PageList>
      </PageContent>

      {/* Add */}
      <KortixBottomSheetModal
        ref={addSheetRef}
        snapPoints={['92%']}
        enableDynamicSizing={false}
        keyboardBehavior="interactive"
        keyboardBlurBehavior="restore"
      >
        {canManage ? (
          <SharedSecretForm
            projectId={projectId}
            initialName=""
            nameEditable
            configured={false}
            initialSharing={{ mode: 'project' }}
            onClose={() => addSheetRef.current?.dismiss()}
            isDark={isDark}
          />
        ) : (
          <PersonalSecretForm
            projectId={projectId}
            initialName=""
            nameEditable
            onClose={() => addSheetRef.current?.dismiss()}
            isDark={isDark}
          />
        )}
      </KortixBottomSheetModal>

      {/* Detail */}
      <KortixBottomSheetModal
        ref={detailSheetRef}
        snapPoints={['92%']}
        enableDynamicSizing={false}
        onDismiss={() => setSelectedName(null)}
        keyboardBehavior="interactive"
        keyboardBlurBehavior="restore"
      >
        {selectedRow ? (
          <SecretDetailSheet
            projectId={projectId}
            row={selectedRow}
            canManage={canManage}
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
