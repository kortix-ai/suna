/**
 * Shared Agent + Model picker fields for the git-backed trigger (Schedules /
 * Webhooks) create + detail sheets — mobile parity for
 * apps/web/src/components/projects/schedule-view.tsx's AgentModelSection.
 *
 * Inline expand/collapse rows (matching this file family's existing Timezone
 * picker pattern) rather than a nested bottom sheet — @gorhom/bottom-sheet
 * doesn't stack modals here, so pickers expand in place instead.
 */

import React, { useState } from 'react';
import { View, Text as RNText, TouchableOpacity, ActivityIndicator } from 'react-native';
import { ChevronRight, Check } from 'lucide-react-native';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/theme-colors';
import {
  useProjectAgentsForTrigger,
  useProjectModelCatalogForTrigger,
} from '@/lib/projects/hooks';
import { haptics } from '@/lib/haptics';

const MONO = 'Menlo';

function useFieldColors(isDark: boolean) {
  return {
    fg: isDark ? '#F8F8F8' : '#121215',
    muted: isDark ? '#9b9b9b' : '#6e6e6e',
    border: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.12)',
    inputBg: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.03)',
  };
}

function FieldLabel({ children, muted }: { children: React.ReactNode; muted: string }) {
  return (
    <Text style={{ fontSize: 12, fontFamily: 'Roobert-Medium', color: muted, marginTop: 14, marginBottom: 6 }}>
      {children}
    </Text>
  );
}

// ─── Agent ────────────────────────────────────────────────────────────────────

export function AgentPickerField({
  projectId,
  value,
  onChange,
  isDark,
}: {
  projectId: string;
  /** Selected agent name, or null to leave unset (server defaults to "default"). */
  value: string | null;
  onChange: (name: string) => void;
  isDark: boolean;
}) {
  const theme = useThemeColors();
  const { fg, muted, border, inputBg } = useFieldColors(isDark);
  const [open, setOpen] = useState(false);
  const { agents, isLoading } = useProjectAgentsForTrigger(projectId);

  return (
    <View>
      <FieldLabel muted={muted}>Agent</FieldLabel>
      <TouchableOpacity
        onPress={() => { haptics.tap(); setOpen((v) => !v); }}
        activeOpacity={0.7}
        style={{ height: 44, borderRadius: 11, borderWidth: 1, borderColor: border, backgroundColor: inputBg, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center' }}
      >
        <RNText style={{ flex: 1, fontSize: 14, color: fg, fontFamily: MONO }} numberOfLines={1}>
          {value || 'default'}
        </RNText>
        {isLoading ? (
          <ActivityIndicator size="small" color={muted} />
        ) : (
          <ChevronRight size={16} color={muted} style={{ transform: [{ rotate: open ? '90deg' : '0deg' }] }} />
        )}
      </TouchableOpacity>
      {open && (
        <View style={{ marginTop: 8, borderRadius: 11, borderWidth: 1, borderColor: border, overflow: 'hidden' }}>
          {agents.length === 0 && !isLoading && (
            <View style={{ paddingHorizontal: 12, paddingVertical: 11 }}>
              <Text style={{ fontSize: 13, color: muted }}>No agents found for this project.</Text>
            </View>
          )}
          {agents.map((a, i) => {
            const selected = value === a.name;
            return (
              <TouchableOpacity
                key={a.name}
                onPress={() => { haptics.selection(); onChange(a.name); setOpen(false); }}
                activeOpacity={0.6}
                style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 11, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: border }}
              >
                <View style={{ flex: 1 }}>
                  <RNText style={{ fontSize: 13.5, fontFamily: MONO, color: fg }}>{a.name}</RNText>
                  {a.description ? (
                    <RNText style={{ fontSize: 11.5, color: muted, marginTop: 2 }} numberOfLines={1}>{a.description}</RNText>
                  ) : null}
                </View>
                {selected && <Check size={15} color={theme.primary} strokeWidth={3} />}
              </TouchableOpacity>
            );
          })}
        </View>
      )}
    </View>
  );
}

// ─── Model ────────────────────────────────────────────────────────────────────

export function ModelPickerField({
  projectId,
  value,
  onChange,
  isDark,
}: {
  projectId: string;
  /** Selected wire model id, or null to resolve the agent/account/platform default at fire time. */
  value: string | null;
  onChange: (modelID: string | null) => void;
  isDark: boolean;
}) {
  const theme = useThemeColors();
  const { fg, muted, border, inputBg } = useFieldColors(isDark);
  const [open, setOpen] = useState(false);
  const { models, isLoading, gatewayDisabled } = useProjectModelCatalogForTrigger(projectId);
  const current = models.find((m) => m.modelID === value);

  if (gatewayDisabled) {
    return (
      <View>
        <FieldLabel muted={muted}>Model</FieldLabel>
        <Text style={{ fontSize: 12.5, color: muted, lineHeight: 18 }}>
          Enable the LLM gateway for this project (Settings → LLM) to pin a model for this trigger.
        </Text>
      </View>
    );
  }

  return (
    <View>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 14 }}>
        <Text style={{ fontSize: 12, fontFamily: 'Roobert-Medium', color: muted }}>Model</Text>
        {value && (
          <TouchableOpacity onPress={() => { haptics.tap(); onChange(null); }} hitSlop={6}>
            <Text style={{ fontSize: 12, fontFamily: 'Roobert-Medium', color: theme.primary }}>Use default</Text>
          </TouchableOpacity>
        )}
      </View>
      <TouchableOpacity
        onPress={() => { haptics.tap(); setOpen((v) => !v); }}
        activeOpacity={0.7}
        style={{ height: 44, borderRadius: 11, borderWidth: 1, borderColor: border, backgroundColor: inputBg, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', marginTop: 6 }}
      >
        <RNText style={{ flex: 1, fontSize: 14, color: fg }} numberOfLines={1}>
          {current?.modelName ?? 'Default'}
        </RNText>
        {isLoading ? (
          <ActivityIndicator size="small" color={muted} />
        ) : (
          <ChevronRight size={16} color={muted} style={{ transform: [{ rotate: open ? '90deg' : '0deg' }] }} />
        )}
      </TouchableOpacity>
      {open && (
        <View style={{ marginTop: 8, borderRadius: 11, borderWidth: 1, borderColor: border, overflow: 'hidden' }}>
          <TouchableOpacity
            onPress={() => { haptics.selection(); onChange(null); setOpen(false); }}
            activeOpacity={0.6}
            style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 11 }}
          >
            <RNText style={{ flex: 1, fontSize: 13.5, color: fg }}>Default</RNText>
            {value == null && <Check size={15} color={theme.primary} strokeWidth={3} />}
          </TouchableOpacity>
          {models.map((m) => {
            const selected = value === m.modelID;
            return (
              <TouchableOpacity
                key={m.modelID}
                onPress={() => { haptics.selection(); onChange(m.modelID); setOpen(false); }}
                activeOpacity={0.6}
                style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 11, borderTopWidth: 1, borderTopColor: border }}
              >
                <RNText style={{ flex: 1, fontSize: 13.5, color: fg }} numberOfLines={1}>{m.modelName}</RNText>
                {selected && <Check size={15} color={theme.primary} strokeWidth={3} />}
              </TouchableOpacity>
            );
          })}
        </View>
      )}
    </View>
  );
}
