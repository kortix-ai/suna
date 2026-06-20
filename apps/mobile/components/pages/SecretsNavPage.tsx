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
  Key,
  User,
  Lock,
  Users,
  Globe,
  Check,
  ChevronRight,
  Trash2,
  X,
  ShieldAlert,
  type LucideIcon,
} from 'lucide-react-native';
import { Text } from '@/components/ui/text';
import { PageHeader } from '@/components/ui/page-header';
import { PageContent } from '@/components/ui/page-content';
import { SearchListHeader } from '@/components/ui/search-list-header';
import { useThemeColors, getSheetBg } from '@/lib/theme-colors';
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

interface PageTabLike {
  id: string;
  label: string;
  icon: string;
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

interface Row {
  name: string;
  secret: ProjectSecret | null;
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

function statusText(s: ProjectSecret | null): string {
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

const SHARE_OPTIONS: { mode: 'project' | 'private' | 'members'; label: string; icon: LucideIcon }[] = [
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
  const fg = isDark ? '#F8F8F8' : '#121215';
  const muted = isDark ? '#9b9b9b' : '#6e6e6e';
  const border = isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)';

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
            <TouchableOpacity
              key={opt.mode}
              onPress={() => {
                haptics.selection();
                if (opt.mode === 'project') onChange({ mode: 'project' });
                else if (opt.mode === 'private') onChange({ mode: 'private', ownerId: '' });
                else onChange({ mode: 'members', memberIds });
              }}
              activeOpacity={0.7}
              style={{
                flex: 1, alignItems: 'center', gap: 5, paddingVertical: 11, borderRadius: 12,
                borderWidth: 1.5, borderColor: on ? theme.primary : border,
                backgroundColor: on ? theme.primaryLight : 'transparent',
              }}
            >
              <Icon size={17} color={on ? theme.primary : muted} />
              <Text style={{ fontSize: 12, fontFamily: 'Roobert-Medium', color: on ? theme.primary : muted }}>{opt.label}</Text>
            </TouchableOpacity>
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
                <TouchableOpacity
                  key={m.user_id}
                  onPress={() => { haptics.selection(); toggleMember(m.user_id); }}
                  activeOpacity={0.6}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingVertical: 10, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: border }}
                >
                  <View style={{ width: 26, height: 26, borderRadius: 13, backgroundColor: theme.primaryLight, alignItems: 'center', justifyContent: 'center' }}>
                    <Text style={{ fontSize: 11, fontFamily: 'Roobert-Medium', color: theme.primary }}>{(m.email ?? m.user_id).charAt(0).toUpperCase()}</Text>
                  </View>
                  <Text style={{ flex: 1, fontSize: 13.5, color: fg }} numberOfLines={1}>{m.email ?? m.user_id}</Text>
                  <View style={{ width: 20, height: 20, borderRadius: 6, borderWidth: on ? 0 : 1.5, borderColor: border, backgroundColor: on ? theme.primary : 'transparent', alignItems: 'center', justifyContent: 'center' }}>
                    {on && <Check size={13} color="#fff" strokeWidth={3} />}
                  </View>
                </TouchableOpacity>
              );
            })
          )}
        </View>
      )}
    </View>
  );
}

// ─── Shared value form ────────────────────────────────────────────────────────

function SharedSecretForm({
  projectId,
  initialName,
  nameEditable,
  configured,
  initialSharing,
  onClose,
  isDark,
}: {
  projectId: string;
  initialName: string;
  nameEditable: boolean;
  configured: boolean;
  initialSharing: ConnectorSharing;
  onClose: () => void;
  isDark: boolean;
}) {
  const theme = useThemeColors();
  const insets = useSafeAreaInsets();
  const upsert = useUpsertProjectSecret(projectId);

  const [name, setName] = useState(initialName);
  const [value, setValue] = useState('');
  const [sharing, setSharing] = useState<ConnectorSharing>(initialSharing);

  const fg = isDark ? '#F8F8F8' : '#121215';
  const muted = isDark ? '#9b9b9b' : '#6e6e6e';
  const border = isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.12)';
  const inputBg = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.03)';

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
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingTop: 4, paddingBottom: 12 }}>
        <Text style={{ flex: 1, fontSize: 18, fontFamily: 'Roobert-Medium', color: fg }}>
          {nameEditable ? 'Add a secret' : configured ? 'Edit shared value' : 'Set shared value'}
        </Text>
        <TouchableOpacity onPress={() => { haptics.tap(); onClose(); }} hitSlop={8} style={{ width: 30, height: 30, borderRadius: 15, backgroundColor: inputBg, alignItems: 'center', justifyContent: 'center' }}>
          <X size={17} color={muted} />
        </TouchableOpacity>
      </View>

      <BottomSheetScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16 }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        <Text style={{ fontSize: 12, fontFamily: 'Roobert-Medium', color: muted, marginBottom: 6 }}>Name</Text>
        <BottomSheetTextInput
          value={name}
          onChangeText={(t) => setName(sanitizeName(t))}
          editable={nameEditable}
          placeholder="STRIPE_API_KEY"
          placeholderTextColor={muted}
          autoCapitalize="characters"
          autoCorrect={false}
          style={{ height: 44, borderRadius: 11, borderWidth: 1, borderColor: border, backgroundColor: inputBg, paddingHorizontal: 12, fontSize: 14, color: nameEditable ? fg : muted, fontFamily: MONO, marginBottom: 4 }}
        />
        {nameEditable && name.length > 0 && !nameValid && (
          <Text style={{ fontSize: 12, color: '#ef4444', marginBottom: 8 }}>
            Use A–Z, 0–9 and _, starting with a letter. KORTIX_ is reserved.
          </Text>
        )}

        <Text style={{ fontSize: 12, fontFamily: 'Roobert-Medium', color: muted, marginTop: 12, marginBottom: 6 }}>
          {configured ? 'New value' : 'Value'}
        </Text>
        <BottomSheetTextInput
          value={value}
          onChangeText={setValue}
          placeholder={configured ? 'Leave blank to keep current' : 'Paste the secret value…'}
          placeholderTextColor={muted}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          style={{ minHeight: 44, borderRadius: 11, borderWidth: 1, borderColor: border, backgroundColor: inputBg, paddingHorizontal: 12, fontSize: 14, color: fg, fontFamily: 'Roobert' }}
        />
        <Text style={{ fontSize: 12.5, color: muted, marginTop: 6 }}>Encrypted at rest and never shown again.</Text>

        <Text style={{ fontSize: 12, fontFamily: 'Roobert-Medium', color: muted, marginTop: 18, marginBottom: 8 }}>Who can use it</Text>
        <SharingField projectId={projectId} value={sharing} onChange={setSharing} isDark={isDark} />
      </BottomSheetScrollView>

      <View style={{ padding: 16, paddingBottom: insets.bottom + 16, borderTopWidth: 1, borderTopColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)' }}>
        <TouchableOpacity
          onPress={handleSave}
          disabled={!canSave}
          activeOpacity={0.85}
          style={{ height: 48, borderRadius: 9999, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8, backgroundColor: theme.primary, opacity: canSave ? 1 : 0.5 }}
        >
          {upsert.isPending && <ActivityIndicator size="small" color={theme.primaryForeground} />}
          <Text style={{ fontSize: 15, fontFamily: 'Roobert-Medium', color: theme.primaryForeground }}>Save shared value</Text>
        </TouchableOpacity>
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
  isDark,
}: {
  projectId: string;
  initialName: string;
  nameEditable: boolean;
  onClose: () => void;
  isDark: boolean;
}) {
  const theme = useThemeColors();
  const insets = useSafeAreaInsets();
  const setPersonal = useSetPersonalProjectSecret(projectId);

  const [name, setName] = useState(initialName);
  const [value, setValue] = useState('');

  const fg = isDark ? '#F8F8F8' : '#121215';
  const muted = isDark ? '#9b9b9b' : '#6e6e6e';
  const border = isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.12)';
  const inputBg = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.03)';

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
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingTop: 4, paddingBottom: 12 }}>
        <Text style={{ flex: 1, fontSize: 18, fontFamily: 'Roobert-Medium', color: fg }}>
          {nameEditable ? 'Add your value' : 'Your value'}
        </Text>
        <TouchableOpacity onPress={() => { haptics.tap(); onClose(); }} hitSlop={8} style={{ width: 30, height: 30, borderRadius: 15, backgroundColor: inputBg, alignItems: 'center', justifyContent: 'center' }}>
          <X size={17} color={muted} />
        </TouchableOpacity>
      </View>

      <BottomSheetScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16 }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        <Text style={{ fontSize: 12, fontFamily: 'Roobert-Medium', color: muted, marginBottom: 6 }}>Name</Text>
        <BottomSheetTextInput
          value={name}
          onChangeText={(t) => setName(sanitizeName(t))}
          editable={nameEditable}
          placeholder="STRIPE_API_KEY"
          placeholderTextColor={muted}
          autoCapitalize="characters"
          autoCorrect={false}
          style={{ height: 44, borderRadius: 11, borderWidth: 1, borderColor: border, backgroundColor: inputBg, paddingHorizontal: 12, fontSize: 14, color: nameEditable ? fg : muted, fontFamily: MONO, marginBottom: 12 }}
        />

        <Text style={{ fontSize: 12, fontFamily: 'Roobert-Medium', color: muted, marginBottom: 6 }}>Your value</Text>
        <BottomSheetTextInput
          value={value}
          onChangeText={setValue}
          placeholder="Paste your value…"
          placeholderTextColor={muted}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          style={{ minHeight: 44, borderRadius: 11, borderWidth: 1, borderColor: border, backgroundColor: inputBg, paddingHorizontal: 12, fontSize: 14, color: fg, fontFamily: 'Roobert' }}
        />
        <Text style={{ fontSize: 12.5, color: muted, marginTop: 6 }}>
          Only used in your own sessions. Other members never see it.
        </Text>
      </BottomSheetScrollView>

      <View style={{ padding: 16, paddingBottom: insets.bottom + 16, borderTopWidth: 1, borderTopColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)' }}>
        <TouchableOpacity
          onPress={handleSave}
          disabled={!canSave}
          activeOpacity={0.85}
          style={{ height: 48, borderRadius: 9999, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8, backgroundColor: theme.primary, opacity: canSave ? 1 : 0.5 }}
        >
          {setPersonal.isPending && <ActivityIndicator size="small" color={theme.primaryForeground} />}
          <Text style={{ fontSize: 15, fontFamily: 'Roobert-Medium', color: theme.primaryForeground }}>Use my own value</Text>
        </TouchableOpacity>
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
  const fg = isDark ? '#F8F8F8' : '#121215';
  const border = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';
  const color = destructive ? '#ef4444' : fg;
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={busy}
      activeOpacity={0.7}
      style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: border, opacity: busy ? 0.5 : 1 }}
    >
      {destructive && <Trash2 size={16} color={color} style={{ marginRight: 10 }} />}
      <Text style={{ flex: 1, fontSize: 15, fontFamily: 'Roobert-Medium', color }}>{label}</Text>
      {busy ? <ActivityIndicator size="small" color={color} /> : !destructive && <ChevronRight size={18} color={isDark ? '#9b9b9b' : '#6e6e6e'} />}
    </TouchableOpacity>
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
  const setPersonal = useSetPersonalProjectSecret(projectId);
  const deletePersonal = useDeletePersonalProjectSecret(projectId);
  const deleteShared = useDeleteProjectSecret(projectId);

  const s = row.secret;
  const fg = isDark ? '#F8F8F8' : '#121215';
  const muted = isDark ? '#9b9b9b' : '#6e6e6e';
  const border = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';
  const iconBg = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)';
  const closeBg = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)';

  if (view === 'shared') {
    return (
      <SharedSecretForm
        projectId={projectId}
        initialName={row.name}
        nameEditable={false}
        configured={!!s?.configured}
        initialSharing={s?.sharing ?? { mode: 'project' }}
        onClose={() => setView('detail')}
        isDark={isDark}
      />
    );
  }
  if (view === 'personal') {
    return (
      <PersonalSecretForm
        projectId={projectId}
        initialName={row.name}
        nameEditable={false}
        onClose={() => setView('detail')}
        isDark={isDark}
      />
    );
  }

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

  return (
    <View style={{ flex: 1 }}>
      {/* Header */}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingTop: 4, paddingBottom: 14, borderBottomWidth: 1, borderBottomColor: border }}>
        <View style={{ width: 40, height: 40, borderRadius: 11, backgroundColor: iconBg, alignItems: 'center', justifyContent: 'center' }}>
          {mineActive ? <User size={19} color={muted} /> : <Key size={19} color={muted} />}
        </View>
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 16, fontFamily: MONO, color: fg }} numberOfLines={1}>{row.name}</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 3 }}>
            <Text style={{ fontSize: 12.5, fontFamily: 'Roobert', color: muted }}>{statusText(s)}</Text>
            {row.required && <Text style={{ fontSize: 11, fontFamily: 'Roobert-Medium', color: '#d97706' }}>· Required</Text>}
          </View>
        </View>
        <TouchableOpacity onPress={() => { haptics.tap(); onClose(); }} hitSlop={8} style={{ width: 30, height: 30, borderRadius: 15, backgroundColor: closeBg, alignItems: 'center', justifyContent: 'center' }}>
          <X size={17} color={muted} />
        </TouchableOpacity>
      </View>

      <BottomSheetScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 32 }} showsVerticalScrollIndicator={false}>
        {/* Source chooser — only when a personal value or a usable shared value exists */}
        {(s?.mine || sharedSelectable) && (
          <>
            <Text style={{ fontSize: 11, fontFamily: 'Roobert-Medium', color: muted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>Use in my sessions</Text>
            <View style={{ flexDirection: 'row', backgroundColor: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)', borderRadius: 9999, padding: 3, marginBottom: 18 }}>
              {([
                { key: 'shared', label: 'Shared', on: s?.effective_source === 'shared', enabled: sharedSelectable, onPress: chooseShared },
                { key: 'mine', label: 'Mine', on: mineActive, enabled: true, onPress: chooseMine },
              ] as const).map((opt) => (
                <TouchableOpacity
                  key={opt.key}
                  onPress={opt.enabled ? opt.onPress : undefined}
                  disabled={!opt.enabled}
                  activeOpacity={0.7}
                  style={{ flex: 1, paddingVertical: 8, borderRadius: 9999, alignItems: 'center', backgroundColor: opt.on ? (isDark ? 'rgba(255,255,255,0.12)' : '#FFFFFF') : 'transparent', opacity: opt.enabled ? 1 : 0.4 }}
                >
                  <Text style={{ fontSize: 13, fontFamily: opt.on ? 'Roobert-Medium' : 'Roobert', color: opt.on ? fg : muted }}>{opt.label}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </>
        )}

        {/* Personal value */}
        <Text style={{ fontSize: 11, fontFamily: 'Roobert-Medium', color: muted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 2 }}>Your value</Text>
        <ActionRow label={s?.mine ? 'Edit my value' : 'Set my value'} onPress={() => { haptics.tap(); setView('personal'); }} isDark={isDark} />
        {s?.mine && (
          <ActionRow label="Remove my value" destructive onPress={confirmRemovePersonal} isDark={isDark} busy={deletePersonal.isPending} />
        )}

        {/* Shared value */}
        {canManageShared && (
          <>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 22, marginBottom: 2 }}>
              <Text style={{ fontSize: 11, fontFamily: 'Roobert-Medium', color: muted, textTransform: 'uppercase', letterSpacing: 0.5 }}>Shared value</Text>
              {scope && <Text style={{ fontSize: 11, fontFamily: 'Roobert-Medium', color: theme.primary }}>· {scope}</Text>}
            </View>
            <ActionRow label={s?.configured ? 'Edit shared value' : 'Set shared value'} onPress={() => { haptics.tap(); setView('shared'); }} isDark={isDark} />
            {s?.configured && (
              <ActionRow label="Delete shared value" destructive onPress={confirmDeleteShared} isDark={isDark} busy={deleteShared.isPending} />
            )}
          </>
        )}
      </BottomSheetScrollView>
    </View>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

function ManifestBanner({ status, path, error, isDark }: { status?: string; path?: string; error?: string; isDark: boolean }) {
  const muted = isDark ? '#9b9b9b' : '#6e6e6e';
  if (!status || status === 'loaded') return null;
  const warn = status === 'error';
  const color = warn ? '#d97706' : muted;
  const bg = warn ? 'rgba(217,119,6,0.08)' : (isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)');
  const text =
    status === 'missing'
      ? 'No kortix.toml manifest — declare required env keys to track them here.'
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

  const bgColor = isDark ? '#090909' : '#FFFFFF';
  const fg = isDark ? '#F8F8F8' : '#121215';
  const muted = isDark ? '#9b9b9b' : '#6e6e6e';
  const border = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';

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
      />

      <PageContent>
        <ManifestBanner status={data?.manifest_status} path={data?.manifest_path} error={data?.manifest_error} isDark={isDark} />

        {missingRequired > 0 && (
          <View style={{ marginHorizontal: 16, marginTop: 12, padding: 12, borderRadius: 12, backgroundColor: 'rgba(217,119,6,0.08)', flexDirection: 'row', gap: 10, alignItems: 'center' }}>
            <ShieldAlert size={16} color="#d97706" />
            <Text style={{ flex: 1, fontSize: 12.5, color: '#d97706' }}>
              {missingRequired} required {missingRequired === 1 ? 'secret is' : 'secrets are'} not set.
            </Text>
          </View>
        )}

        <SearchListHeader
          value={search}
          onChangeText={setSearch}
          placeholder="Search secrets"
          onAdd={() => { haptics.tap(); addSheetRef.current?.present(); }}
        />

        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingBottom: insets.bottom + 40 }}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {isLoading ? (
            <View style={{ paddingVertical: 48, alignItems: 'center' }}>
              <ActivityIndicator size="small" color={muted} />
            </View>
          ) : isError ? (
            <View style={{ padding: 24, alignItems: 'center', gap: 12 }}>
              <Text style={{ fontSize: 14, color: muted, textAlign: 'center' }}>{(error as Error)?.message ?? 'Failed to load secrets'}</Text>
              <TouchableOpacity onPress={() => refetch()} style={{ paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, borderWidth: 1, borderColor: border }}>
                <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: fg }}>Retry</Text>
              </TouchableOpacity>
            </View>
          ) : filtered.length === 0 ? (
            <View style={{ padding: 40, alignItems: 'center', gap: 10 }}>
              <Key size={26} color={muted} />
              <Text style={{ fontSize: 14, color: muted, textAlign: 'center' }}>
                {rows.length === 0 ? 'No secrets yet.' : 'No secrets match your search.'}
              </Text>
            </View>
          ) : (
            filtered.map((row, i) => {
              const s = row.secret;
              const Icon = s?.effective_source === 'mine' ? User : Key;
              const amber = row.required && (s?.effective_source ?? 'none') === 'none';
              const scope = sharingScopeLabel(s?.sharing);
              return (
                <View key={row.name}>
                  <TouchableOpacity
                    onPress={() => openRow(row.name)}
                    activeOpacity={0.6}
                    style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, gap: 12, backgroundColor: amber ? 'rgba(217,119,6,0.05)' : 'transparent' }}
                  >
                    <View style={{ width: 38, height: 38, borderRadius: 10, backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)', alignItems: 'center', justifyContent: 'center' }}>
                      <Icon size={18} color={muted} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                        <Text style={{ fontSize: 14.5, fontFamily: MONO, color: fg }} numberOfLines={1}>{row.name}</Text>
                        {row.required && <Text style={{ fontSize: 10.5, fontFamily: 'Roobert-Medium', color: '#d97706' }}>REQUIRED</Text>}
                        {row.optional && <Text style={{ fontSize: 10.5, fontFamily: 'Roobert-Medium', color: muted }}>OPTIONAL</Text>}
                      </View>
                      <Text style={{ fontSize: 12.5, color: muted, marginTop: 2 }} numberOfLines={1}>
                        {statusText(s)}{scope ? ` · ${scope}` : ''}
                      </Text>
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

      {/* Add */}
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
      </BottomSheetModal>

      {/* Detail */}
      <BottomSheetModal
        ref={detailSheetRef}
        snapPoints={['92%']}
        enableDynamicSizing={false}
        onDismiss={() => setSelectedName(null)}
        backgroundStyle={{ backgroundColor: getSheetBg(isDark) }}
        handleIndicatorStyle={{ backgroundColor: isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.2)' }}
        keyboardBehavior="interactive"
        keyboardBlurBehavior="restore"
        backdropComponent={(props) => <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} opacity={0.5} />}
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
      </BottomSheetModal>
    </View>
  );
}
