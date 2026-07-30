'use client';

/** The Kortix-layer field block (identity + platform-enforced governance) —
 *  runtime-agnostic, saves to `kortix.yaml`. */

import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  RobotIcon as Bot,
  LockIcon as Lock,
  ShieldCheckIcon as ShieldCheck,
} from '@phosphor-icons/react';
import Hint from '@/components/ui/hint';
import { cn } from '@/lib/utils';
import { FieldRow, SectionHeader, Segmented } from './agent-editor-primitives';
import { GrantSetField, KortixCliField } from './grant-mode-field';
import { pruneRequiredConnectors } from './connectors-personal';
import { WORKSPACE_MODES, WORKSPACE_MODE_HELP } from './agent-editor-catalog';
import type { AgentConfigBlock, AgentGrantSetV2 } from '@kortix/sdk';

/**
 * Marks one granted connector profile as required before session start.
 */
function RequiredConnectorToggle({
  active,
  onToggle,
}: {
  active: boolean;
  onToggle: () => void;
}) {
  return (
    <Hint
      label={
        active
          ? 'Required before session start. The connector profile authorization strategy selects the valid authorization.'
          : 'Optional at session start. Click to require this connector profile.'
      }
    >
      <button
        type="button"
        aria-pressed={active}
        aria-label={active ? 'Required before session start' : 'Optional at session start'}
        onClick={onToggle}
        className={cn(
          'flex size-7 shrink-0 items-center justify-center rounded transition-[color,background-color,transform] active:scale-[0.96]',
          active
            ? 'bg-kortix-purple/15 text-kortix-purple'
            : 'text-muted-foreground/40 hover:text-muted-foreground hover:bg-muted/50',
        )}
      >
        <Lock className="size-3.5" />
      </button>
    </Hint>
  );
}

export function KortixLayerFields({
  draft,
  set,
  skillsOptions,
  connectorOptions,
  secretOptions,
  sandboxOptions,
}: {
  draft: AgentConfigBlock;
  set: <K extends keyof AgentConfigBlock>(key: K, value: AgentConfigBlock[K]) => void;
  skillsOptions: { id: string; label: string }[];
  connectorOptions: { id: string; label: string }[];
  secretOptions: { id: string; label: string }[];
  sandboxOptions: { id: string; label: string }[];
}) {
  return (
    <>
      <section className="space-y-4">
        <SectionHeader icon={Bot} title="Identity" />
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-foreground/80 text-xs font-medium">Enabled</p>
            <p className="text-muted-foreground/60 text-[11px]">
              Disabled agents can't start sessions.
            </p>
          </div>
          <Switch
            checked={draft.enabled !== false}
            onCheckedChange={(v) => set('enabled', v ? undefined : false)}
          />
        </div>
        <FieldRow label="Environment">
          <div className="space-y-1.5">
            <Select
              value={draft.sandbox ?? '__inherit__'}
              onValueChange={(value) =>
                set('sandbox', value === '__inherit__' ? undefined : value)
              }
            >
              <SelectTrigger className="h-9 w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__inherit__">Project default</SelectItem>
                {sandboxOptions.map((option) => (
                  <SelectItem key={option.id} value={option.id}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-muted-foreground/60 text-[11px]">
              New sessions and automations use this sandbox template.
            </p>
          </div>
        </FieldRow>
      </section>

      <section className="space-y-4">
        <SectionHeader icon={ShieldCheck} title="Governance" />
        <p className="text-muted-foreground/60 text-[11px] leading-relaxed text-pretty">
          Enforced platform-side. Deny-by-default: an empty grant means the agent gets nothing until
          you grant it.
        </p>
        <FieldRow label="Skills">
          <GrantSetField
            value={draft.skills}
            onChange={(v: AgentGrantSetV2) => set('skills', v)}
            options={skillsOptions}
            allLabel="Every project skill."
            emptyLabel="No skills declared in this project yet."
          />
        </FieldRow>
        <FieldRow label="Connectors">
          <GrantSetField
            value={draft.connectors}
            onChange={(v: AgentGrantSetV2) => {
              set('connectors', v);
              const pruned = pruneRequiredConnectors(draft.connectors_required, v);
              if (pruned?.length !== draft.connectors_required?.length) {
                set('connectors_required', pruned);
              }
            }}
            options={connectorOptions}
            allLabel="Every project connector."
            emptyLabel="No connectors in this project yet."
            rowAccessory={(id, isSelected) =>
              isSelected ? (
                <RequiredConnectorToggle
                  active={draft.connectors_required?.includes(id) === true}
                  onToggle={() => {
                    const current = draft.connectors_required ?? [];
                    const next = current.includes(id)
                      ? current.filter((a) => a !== id)
                      : [...current, id];
                    set('connectors_required', next.length ? next : undefined);
                  }}
                />
              ) : null
            }
          />
          {draft.connectors === 'all' && draft.connectors_required?.length ? (
            <p className="text-muted-foreground/60 mt-1.5 text-[11px]">
              Required before session start:{' '}
              <span className="font-mono">{draft.connectors_required.join(', ')}</span> — switch to
              Pick to change.
            </p>
          ) : null}
        </FieldRow>
        <FieldRow label="Secrets">
          <GrantSetField
            value={draft.secrets}
            onChange={(v: AgentGrantSetV2) => set('secrets', v)}
            options={secretOptions}
            allLabel="Every project secret."
            emptyLabel="No secrets in this project yet."
          />
        </FieldRow>
        <FieldRow label="Kortix CLI">
          <KortixCliField
            value={draft.kortix_cli}
            onChange={(v: AgentGrantSetV2) => set('kortix_cli', v)}
          />
        </FieldRow>
        <FieldRow label="Workspace" hint="git boundary (enforced in a later phase)">
          <div className="space-y-1.5">
            <Segmented
              options={WORKSPACE_MODES.map((m) => ({ value: m, label: m }))}
              value={draft.workspace}
              onChange={(v) => set('workspace', v)}
              allowUnset
            />
            <p className="text-muted-foreground/60 text-[11px]">
              {draft.workspace
                ? WORKSPACE_MODE_HELP[draft.workspace]
                : 'Inherits the project default.'}
            </p>
          </div>
        </FieldRow>
      </section>
    </>
  );
}
