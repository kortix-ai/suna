'use client';

/** The Kortix-layer field block (identity + platform-enforced governance) —
 *  runtime-agnostic, saves to `kortix.yaml`. */

import { Switch } from '@/components/ui/switch';
import { Bot, ShieldCheck } from 'lucide-react';
import { FieldRow, SectionHeader, Segmented } from './agent-editor-primitives';
import { GrantSetField, KortixCliField } from './grant-mode-field';
import { WORKSPACE_MODES, WORKSPACE_MODE_HELP } from './agent-editor-catalog';
import type { AgentConfigBlock, AgentGrantSetV2 } from '@kortix/sdk/projects-client';

export function KortixLayerFields({
  draft,
  set,
  skillsOptions,
  connectorOptions,
  secretOptions,
}: {
  draft: AgentConfigBlock;
  set: <K extends keyof AgentConfigBlock>(key: K, value: AgentConfigBlock[K]) => void;
  skillsOptions: { id: string; label: string }[];
  connectorOptions: { id: string; label: string }[];
  secretOptions: { id: string; label: string }[];
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
      </section>

      <section className="space-y-4">
        <SectionHeader icon={ShieldCheck} title="Governance" />
        <p className="text-muted-foreground/60 text-[11px] leading-relaxed text-pretty">
          Enforced platform-side. Deny-by-default: an empty grant means the agent gets nothing
          until you grant it.
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
            onChange={(v: AgentGrantSetV2) => set('connectors', v)}
            options={connectorOptions}
            allLabel="Every project connector."
            emptyLabel="No connectors in this project yet."
          />
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
          <KortixCliField value={draft.kortix_cli} onChange={(v: AgentGrantSetV2) => set('kortix_cli', v)} />
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
              {draft.workspace ? WORKSPACE_MODE_HELP[draft.workspace] : 'Inherits the project default.'}
            </p>
          </div>
        </FieldRow>
      </section>
    </>
  );
}
