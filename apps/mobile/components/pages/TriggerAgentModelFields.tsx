/**
 * Agent and Model fields of the Schedules and Webhooks sheets (create + detail).
 *
 * Both are the app's dropdown (`@/components/ui/select`; Jay, 2026-09-22), not
 * an inline list that pushes the form down. The content portals into
 * `OVERLAY_PORTAL_HOST`, the host above every bottom sheet: the default host
 * sits under the open sheet on Android.
 *
 * The trigger is the app's filled, borderless field (`bg-secondary`,
 * `rounded-xl`, 44pt, no border, no shadow), not RNR's bordered default.
 *
 * Model options come from `/model-picker` (8 to 13 enabled models), never from
 * `/llm-catalog` (thousands): see `useProjectModelCatalogForTrigger`.
 */
import * as React from 'react';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  type Option,
} from '@/components/ui/select';
import { Text } from '@/components/ui/text';
import { haptics } from '@/lib/haptics';
import { useProjectAgentsForTrigger, useProjectModelCatalogForTrigger } from '@/lib/projects/hooks';
import { agentDisplayName } from '@/lib/session/composer-config';
import { OVERLAY_PORTAL_HOST } from '@/lib/ui/portal-hosts';

/** The model field's "no pin" choice: the agent / project / account default applies. */
const DEFAULT_MODEL_VALUE = '__default__';

/** The field's title: a settings group title (muted, 16pt inset), like "Prompt" beside it. */
function FieldTitle({ nativeID, children }: { nativeID?: string; children: string }) {
  return (
    <Text variant="muted" nativeID={nativeID} className="px-4">
      {children}
    </Text>
  );
}

const TRIGGER_CLASS = 'h-11 rounded-xl border-0 bg-secondary px-4 shadow-none';

function useContentInsets() {
  const insets = useSafeAreaInsets();
  return { top: insets.top, bottom: insets.bottom + 12, left: 16, right: 16 };
}

// ─── Agent ────────────────────────────────────────────────────────────────────

export function AgentPickerField({
  projectId,
  value,
  onChange,
  flush = false,
}: {
  projectId: string;
  /** Selected agent name, or null to leave unset (the server runs the default agent). */
  value: string | null;
  onChange: (name: string) => void;
  /** No top margin: the parent's gap spaces the field. */
  flush?: boolean;
  /** @deprecated The field reads the theme itself. Ignored. */
  isDark?: boolean;
}) {
  const contentInsets = useContentInsets();
  const { agents, isLoading } = useProjectAgentsForTrigger(projectId);
  const selected: Option = value ? { value, label: agentDisplayName(value) } : undefined;

  return (
    <View className={flush ? 'gap-2' : 'mt-5 gap-2'}>
      <FieldTitle nativeID="trigger-agent">Agent</FieldTitle>
      <Select
        value={selected}
        onValueChange={(option) => {
          if (!option) return;
          haptics.selection();
          onChange(option.value);
        }}>
        <SelectTrigger aria-labelledby="trigger-agent" className={TRIGGER_CLASS} disabled={isLoading}>
          <SelectValue placeholder={isLoading ? 'Loading agents…' : 'Default agent'} className="text-base" />
        </SelectTrigger>
        <SelectContent portalHost={OVERLAY_PORTAL_HOST} insets={contentInsets} className="w-64">
          {agents.length === 0 ? (
            <Text variant="muted" className="px-2 py-2">
              No agents in this project
            </Text>
          ) : (
            agents.map((agent) => (
              <SelectItem key={agent.name} value={agent.name} label={agentDisplayName(agent.name)} />
            ))
          )}
        </SelectContent>
      </Select>
    </View>
  );
}

// ─── Model ────────────────────────────────────────────────────────────────────

export function ModelPickerField({
  projectId,
  value,
  onChange,
  flush = false,
}: {
  projectId: string;
  /** Selected wire model id, or null to resolve the agent/account/platform default at fire time. */
  value: string | null;
  onChange: (modelID: string | null) => void;
  /** No top margin: the parent's gap spaces the field. */
  flush?: boolean;
  /** @deprecated The field reads the theme itself. Ignored. */
  isDark?: boolean;
}) {
  const contentInsets = useContentInsets();
  const { models, isLoading, gatewayDisabled } = useProjectModelCatalogForTrigger(projectId);

  if (gatewayDisabled) {
    return (
      <View className={flush ? 'gap-2' : 'mt-5 gap-2'}>
        <FieldTitle>Model</FieldTitle>
        <Text variant="muted">Turn on the LLM gateway for this project to pin a model.</Text>
      </View>
    );
  }

  const current = value ? models.find((model) => model.modelID === value) : undefined;
  const selected: Option = value
    ? { value, label: current?.modelName ?? value }
    : { value: DEFAULT_MODEL_VALUE, label: 'Default model' };

  return (
    <View className={flush ? 'gap-2' : 'mt-5 gap-2'}>
      <FieldTitle nativeID="trigger-model">Model</FieldTitle>
      <Select
        value={selected}
        onValueChange={(option) => {
          if (!option) return;
          haptics.selection();
          onChange(option.value === DEFAULT_MODEL_VALUE ? null : option.value);
        }}>
        <SelectTrigger aria-labelledby="trigger-model" className={TRIGGER_CLASS} disabled={isLoading}>
          <SelectValue placeholder={isLoading ? 'Loading models…' : 'Default model'} className="text-base" />
        </SelectTrigger>
        <SelectContent portalHost={OVERLAY_PORTAL_HOST} insets={contentInsets} className="w-72">
          <SelectItem value={DEFAULT_MODEL_VALUE} label="Default model" />
          {models.map((model) => (
            <SelectItem key={model.modelID} value={model.modelID} label={model.modelName} />
          ))}
        </SelectContent>
      </Select>
    </View>
  );
}
