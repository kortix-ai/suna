'use client';

/**
 * The last two open sections of the agent editor: what the agent may reach
 * (Access) and where it runs (Workspace).
 *
 * These were the "Kortix layer" — named for the file they land in
 * (`kortix.yaml`) rather than the question they answer. Same writes, same
 * platform enforcement; the heading now says what it governs.
 */

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { capabilityTabHref } from '@/features/workspace/capabilities/shared/capability-tab-routes';
import {
  SandboxTemplateMenu,
  describeSandboxTemplate,
} from '@/features/workspace/shared/sandbox-template-menu';
import { cn } from '@/lib/utils';
import type { AgentConfigBlock, AgentGrantSetV2, SandboxTemplate } from '@kortix/sdk';
import { useKortixRouteProjectId } from '@kortix/sdk/react';
import { ArrowRightIcon, CaretDownIcon, CubeIcon } from '@phosphor-icons/react';
import Link from 'next/link';
import { WORKSPACE_MODES, WORKSPACE_MODE_HELP, WORKSPACE_MODE_LABEL } from './agent-editor-catalog';
import { EditorSection, SettingRow } from './agent-editor-primitives';
import { pruneRequiredConnectors } from './connectors-personal';
import { type GrantOption, GrantSetField, KortixCliField, grantSummary } from './grant-mode-field';

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
export function RequiredConnectorToggle({
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

/** The summary chip at a grant card's right edge — "All", "3 picked", "None". */
export function GrantChip({ value }: { value: AgentGrantSetV2 | undefined }) {
  const summary = grantSummary(value);
  return (
    <Badge
      variant={summary.tone === 'muted' ? 'muted' : 'outline'}
      size="sm"
      className="tabular-nums"
    >
      {summary.label}
    </Badge>
  );
}

/**
 * Chip plus a link to the project-wide page for the same thing. A grant page
 * picks from what the project has; adding, editing or removing one of them
 * happens on its own Customize tab (Marko, 2026-09-03: "for now … point to
 * the general page … to see & browse em all"). Full CRUD in place is the
 * follow-up.
 */
export function GrantHeaderTrailing({
  value,
  tab,
  label,
}: {
  value: AgentGrantSetV2 | undefined;
  tab: 'skills' | 'connectors' | 'secrets';
  label: string;
}) {
  const projectId = useKortixRouteProjectId();
  return (
    <div className="flex items-center gap-2">
      <GrantChip value={value} />
      {projectId ? (
        <Button asChild variant="ghost" size="sm" className="gap-1 px-2">
          <Link href={capabilityTabHref(projectId, tab)} prefetch>
            {label}
            <ArrowRightIcon className="size-3.5 shrink-0" />
          </Link>
        </Button>
      ) : null}
    </div>
  );
}

interface GrantSectionProps {
  draft: AgentConfigBlock;
  set: SetKortix;
  options: GrantOption[];
}

/*
 * Each grant set is its own page on the agent editor's rail (Marko,
 * 2026-09-03). A page holds one card: the question in the header, the live
 * answer as a chip, the All · Pick · None control and the pick list below.
 */

export function SkillsSection({ draft, set, options }: GrantSectionProps) {
  return (
    <EditorSection
      title="Skills"
      description="Instructions and scripts this agent can load into a session."
      trailing={<GrantHeaderTrailing value={draft.skills} tab="skills" label="All skills" />}
    >
      <div className="py-4">
        <GrantSetField
          value={draft.skills}
          onChange={(v: AgentGrantSetV2) => set('skills', v)}
          options={options}
          allLabel="Every skill in this project, including ones added later."
          emptyLabel="No skills declared in this project yet."
        />
      </div>
    </EditorSection>
  );
}

export function ConnectorsSection({ draft, set, options }: GrantSectionProps) {
  return (
    <EditorSection
      title="Connectors"
      description="Outside services this agent can call. Mark one Required and a session will not start until it resolves."
      trailing={
        <GrantHeaderTrailing value={draft.connectors} tab="connectors" label="All connectors" />
      }
    >
      <div className="space-y-2 py-4">
        <GrantSetField
          value={draft.connectors}
          onChange={(v: AgentGrantSetV2) => {
            set('connectors', v);
            const pruned = pruneRequiredConnectors(draft.connectors_required, v);
            if (pruned?.length !== draft.connectors_required?.length) {
              set('connectors_required', pruned);
            }
          }}
          options={options}
          allLabel="Every connector in this project, including ones added later."
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
      </div>
    </EditorSection>
  );
}

export function SecretsSection({ draft, set, options }: GrantSectionProps) {
  return (
    <EditorSection
      title="Secrets"
      description="Project secrets handed to this agent's sessions as environment variables."
      trailing={<GrantHeaderTrailing value={draft.secrets} tab="secrets" label="All secrets" />}
    >
      <div className="py-4">
        <GrantSetField
          value={draft.secrets}
          onChange={(v: AgentGrantSetV2) => set('secrets', v)}
          options={options}
          allLabel="Every secret in this project, including ones added later."
          emptyLabel="No secrets in this project yet."
        />
      </div>
    </EditorSection>
  );
}

/** Was "Kortix CLI" — the name of the tool, not of what it grants. What the
 *  user is choosing is which project operations the agent may perform; the
 *  CLI is only how it performs them. */
export function ProjectActionsSection({ draft, set }: Omit<GrantSectionProps, 'options'>) {
  return (
    <EditorSection
      title="Project actions"
      description="What this agent may do to the project itself — sessions, triggers, secrets, members — through the Kortix CLI inside a session."
      trailing={<GrantChip value={draft.kortix_cli} />}
    >
      <div className="py-4">
        <KortixCliField
          value={draft.kortix_cli}
          onChange={(v: AgentGrantSetV2) => set('kortix_cli', v)}
        />
      </div>
    </EditorSection>
  );
}

export function WorkspaceSection({
  draft,
  set,
  sandboxTemplates,
  defaultSandboxSlug,
}: {
  draft: AgentConfigBlock;
  set: SetKortix;
  sandboxTemplates: SandboxTemplate[];
  /** The project's default template slug — what an unset agent resolves to. */
  defaultSandboxSlug: string | null;
}) {
  const pinned = draft.sandbox ? sandboxTemplates.find((t) => t.slug === draft.sandbox) : undefined;
  const projectDefault = defaultSandboxSlug
    ? sandboxTemplates.find((t) => t.slug === defaultSandboxSlug)
    : undefined;
  // A pinned slug the project no longer declares still shows as itself, so a
  // stale value never snaps to "Project default" and silently rewrites the
  // manifest on the next save.
  const stalePin = draft.sandbox && !pinned ? draft.sandbox : null;
  const PinnedIcon = pinned ? describeSandboxTemplate(pinned).Icon : CubeIcon;
  return (
    <EditorSection title="Workspace" description="Where this agent runs, and what it can change.">
      <SettingRow
        label="Environment"
        help={
          draft.sandbox
            ? stalePin
              ? 'Pinned to a template this project no longer declares.'
              : 'Pinned for this agent. New sessions and automations use it.'
            : projectDefault
              ? `Follows the project default — currently ${projectDefault.name}.`
              : 'Follows the project default.'
        }
      >
        <SandboxTemplateMenu
          items={sandboxTemplates}
          selectedSlug={draft.sandbox ?? null}
          resolvedSlug={defaultSandboxSlug}
          inherit={{
            label: 'Project default',
            description: 'Whatever the project default is, now and after it changes.',
          }}
          onSelect={(slug) => set('sandbox', slug ?? undefined)}
          align="end"
          trigger={
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-label="Environment"
              className="w-full justify-between gap-2 font-normal"
            >
              <span className="flex min-w-0 items-center gap-2">
                <PinnedIcon className="text-muted-foreground size-3.5 shrink-0" />
                <span className={cn('truncate', stalePin && 'text-kortix-orange font-mono')}>
                  {pinned ? pinned.name : (stalePin ?? 'Project default')}
                </span>
              </span>
              <CaretDownIcon className="text-muted-foreground size-3.5 shrink-0" />
            </Button>
          }
        />
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
