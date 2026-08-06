'use client';

/**
 * The last two open sections of the agent editor: what the agent may reach
 * (Access) and where it runs (Workspace).
 *
 * These were the "Kortix layer" — named for the file they land in
 * (`kortix.yaml`) rather than the question they answer. Same writes, same
 * platform enforcement; the heading now says what it governs.
 */

import Hint from '@/components/ui/hint';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import type { AgentConfigBlock, AgentGrantSetV2 } from '@kortix/sdk';
import { WORKSPACE_MODES, WORKSPACE_MODE_HELP, WORKSPACE_MODE_LABEL } from './agent-editor-catalog';
import { EditorSection, SettingBlock, SettingRow } from './agent-editor-primitives';
import { pruneRequiredConnectors } from './connectors-personal';
import { GrantSetField, KortixCliField } from './grant-mode-field';

/** Every inherit-capable Select shares one sentinel — Radix forbids `""`. */
const INHERIT = '__inherit__';

type SetKortix = <K extends keyof AgentConfigBlock>(key: K, value: AgentConfigBlock[K]) => void;

/**
 * Marks one granted connector as required before session start.
 *
 * A word, not a padlock. The old control was a lock glyph whose only
 * explanation lived in a tooltip, so the state was invisible until you hovered
 * it — and a lock reads as "secured", which is not what this means.
 */
function RequiredConnectorToggle({ active, onToggle }: { active: boolean; onToggle: () => void }) {
  return (
    <Hint
      label={
        active
          ? 'Required before session start. The connector authorization strategy selects the valid connection.'
          : 'Optional at session start. Click to require this connector.'
      }
    >
      <button
        type="button"
        aria-pressed={active}
        aria-label={active ? 'Required before session start' : 'Optional at session start'}
        onClick={onToggle}
        className={cn(
          'shrink-0 rounded px-1.5 py-1 text-xs transition-[color,background-color,transform] active:scale-[0.96]',
          active
            ? 'bg-kortix-purple/15 text-kortix-purple font-medium'
            : 'text-muted-foreground/50 hover:text-muted-foreground hover:bg-muted/50',
        )}
      >
        Required
      </button>
    </Hint>
  );
}

export function AccessSection({
  draft,
  set,
  skillsOptions,
  connectorOptions,
  secretOptions,
}: {
  draft: AgentConfigBlock;
  set: SetKortix;
  skillsOptions: { id: string; label: string }[];
  connectorOptions: { id: string; label: string }[];
  secretOptions: { id: string; label: string }[];
}) {
  return (
    <EditorSection
      title="Access"
      description="Denied by default. This agent reaches nothing until you grant it here."
    >
      <SettingBlock label="Skills" help="Instructions and scripts this agent can load.">
        <GrantSetField
          value={draft.skills}
          onChange={(v: AgentGrantSetV2) => set('skills', v)}
          options={skillsOptions}
          allLabel="Every skill in this project."
          emptyLabel="No skills declared in this project yet."
        />
      </SettingBlock>

      <SettingBlock label="Connectors" help="Outside services this agent can call.">
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
          allLabel="Every connector in this project."
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
          <p className="text-muted-foreground text-xs">
            Required before session start:{' '}
            <span className="font-mono">{draft.connectors_required.join(', ')}</span>. Switch to
            Pick to change it.
          </p>
        ) : null}
      </SettingBlock>

      <SettingBlock
        label="Secrets"
        help="Project secrets handed to this agent as environment variables."
      >
        <GrantSetField
          value={draft.secrets}
          onChange={(v: AgentGrantSetV2) => set('secrets', v)}
          options={secretOptions}
          allLabel="Every secret in this project."
          emptyLabel="No secrets in this project yet."
        />
      </SettingBlock>

      {/* Was "Kortix CLI" — the name of the tool, not of what it grants. What
          the user is choosing is which project operations the agent may
          perform; the CLI is only how it performs them. */}
      <SettingBlock
        label="Project actions"
        help="What this agent may do to the project itself, through the Kortix CLI."
      >
        <KortixCliField
          value={draft.kortix_cli}
          onChange={(v: AgentGrantSetV2) => set('kortix_cli', v)}
        />
      </SettingBlock>
    </EditorSection>
  );
}

export function WorkspaceSection({
  draft,
  set,
  sandboxOptions,
}: {
  draft: AgentConfigBlock;
  set: SetKortix;
  sandboxOptions: { id: string; label: string }[];
}) {
  return (
    <EditorSection title="Workspace" description="Where this agent runs, and what it can change.">
      <SettingRow label="Environment" help="Sandbox template used by new sessions and automations.">
        <Select
          value={draft.sandbox ?? INHERIT}
          onValueChange={(value) => set('sandbox', value === INHERIT ? undefined : value)}
        >
          <SelectTrigger aria-label="Environment" className="w-full" size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={INHERIT}>Project default</SelectItem>
            {sandboxOptions.map((option) => (
              <SelectItem key={option.id} value={option.id}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingRow>

      <SettingRow
        label="File access"
        help={
          draft.workspace ? WORKSPACE_MODE_HELP[draft.workspace] : 'Follows the project default.'
        }
      >
        <Select
          value={draft.workspace ?? INHERIT}
          onValueChange={(value) =>
            set('workspace', value === INHERIT ? undefined : (value as typeof draft.workspace))
          }
        >
          <SelectTrigger aria-label="File access" className="w-full" size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={INHERIT}>Project default</SelectItem>
            {WORKSPACE_MODES.map((mode) => (
              <SelectItem key={mode} value={mode}>
                {WORKSPACE_MODE_LABEL[mode]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingRow>
    </EditorSection>
  );
}
