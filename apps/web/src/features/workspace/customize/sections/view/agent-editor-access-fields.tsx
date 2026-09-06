'use client';

import { useTranslations as useI18nTranslations } from '@/i18n/use-translations';
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
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  return (
    <Hint
      label={active ? tI18nComplete.raw('text49c8975f345b') : tI18nComplete.raw('texta54220c82b33')}
    >
      <button
        type="button"
        aria-pressed={active}
        aria-label={
          active ? tI18nComplete.raw('textd16c94c19673') : tI18nComplete.raw('text63336c8a8e83')
        }
        onClick={onToggle}
        className={cn(
          'shrink-0 rounded px-1.5 py-1 text-xs transition-[color,background-color,transform] active:scale-[0.96]',
          active
            ? 'bg-kortix-purple/15 text-kortix-purple font-medium'
            : 'text-muted-foreground/50 hover:text-muted-foreground hover:bg-muted/50',
        )}
      >
        {tI18nComplete.raw('text4850b174b713')}
      </button>
    </Hint>
  );
}

/** The summary chip at a grant card's right edge — "All", "3 picked", "None". */
export function GrantChip({ value }: { value: AgentGrantSetV2 | undefined }) {
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  const summary = grantSummary(value, tI18nComplete);
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
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  return (
    <EditorSection
      title={tI18nComplete.raw('text66d0f523a379')}
      description={tI18nComplete.raw('textb27e54100c96')}
      trailing={
        <GrantHeaderTrailing
          value={draft.skills}
          tab="skills"
          label={tI18nComplete.raw('text78abcbbfb830')}
        />
      }
    >
      <div className="py-4">
        <GrantSetField
          value={draft.skills}
          onChange={(v: AgentGrantSetV2) => set('skills', v)}
          options={options}
          allLabel={tI18nComplete.raw('textf059c2dbe260')}
          emptyLabel={tI18nComplete.raw('text66e36043ff7c')}
        />
      </div>
    </EditorSection>
  );
}

export function ConnectorsSection({ draft, set, options }: GrantSectionProps) {
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  return (
    <EditorSection
      title={tI18nComplete.raw('textc3d2e79ebdd0')}
      description={tI18nComplete.raw('text00f5aae9f9d3')}
      trailing={
        <GrantHeaderTrailing
          value={draft.connectors}
          tab="connectors"
          label={tI18nComplete.raw('textd83250185d41')}
        />
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
          allLabel={tI18nComplete.raw('text35e54cea7f41')}
          emptyLabel={tI18nComplete.raw('text389fb5217392')}
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
            {tI18nComplete.raw('textf39fe0fefce2')}{' '}
            <span className="font-mono">{draft.connectors_required.join(', ')}</span>
            {tI18nComplete.raw('text954401fb96d1')}
          </p>
        ) : null}
      </div>
    </EditorSection>
  );
}

export function SecretsSection({ draft, set, options }: GrantSectionProps) {
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  return (
    <EditorSection
      title={tI18nComplete.raw('textd8707d411d99')}
      description={tI18nComplete.raw('text7f619d9e30a8')}
      trailing={
        <GrantHeaderTrailing
          value={draft.secrets}
          tab="secrets"
          label={tI18nComplete.raw('text0b38e3daeb93')}
        />
      }
    >
      <div className="py-4">
        <GrantSetField
          value={draft.secrets}
          onChange={(v: AgentGrantSetV2) => set('secrets', v)}
          options={options}
          allLabel={tI18nComplete.raw('text86fdc0c950d5')}
          emptyLabel={tI18nComplete.raw('text82a37b8c2266')}
        />
      </div>
    </EditorSection>
  );
}

/** Was "Kortix CLI" — the name of the tool, not of what it grants. What the
 *  user is choosing is which project operations the agent may perform; the
 *  CLI is only how it performs them. */
export function ProjectActionsSection({ draft, set }: Omit<GrantSectionProps, 'options'>) {
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  return (
    <EditorSection
      title={tI18nComplete.raw('text5d4ef7cc3bec')}
      description={tI18nComplete.raw('text59e679e041ce')}
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
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
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
    <EditorSection
      title={tI18nComplete.raw('text87bb59ba2f92')}
      description={tI18nComplete.raw('text76a5e5a39b4a')}
    >
      <SettingRow
        label={tI18nComplete.raw('text9e471951a1b4')}
        help={
          draft.sandbox
            ? stalePin
              ? tI18nComplete.raw('textb1a5c13d215e')
              : tI18nComplete.raw('text0703d9121fd7')
            : projectDefault
              ? tI18nComplete('textfccaa4c0a0be', { value0: projectDefault.name })
              : tI18nComplete.raw('text64f405e80a8d')
        }
      >
        <SandboxTemplateMenu
          items={sandboxTemplates}
          selectedSlug={draft.sandbox ?? null}
          resolvedSlug={defaultSandboxSlug}
          inherit={{
            label: tI18nComplete.raw('texte8cb80e5c5cb'),
            description: tI18nComplete.raw('textb23625948eee'),
          }}
          onSelect={(slug) => set('sandbox', slug ?? undefined)}
          align="end"
          trigger={
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-label={tI18nComplete.raw('text9e471951a1b4')}
              className="w-full justify-between gap-2 font-normal"
            >
              <span className="flex min-w-0 items-center gap-2">
                <PinnedIcon className="text-muted-foreground size-3.5 shrink-0" />
                <span className={cn('truncate', stalePin && 'text-kortix-orange font-mono')}>
                  {pinned ? pinned.name : (stalePin ?? tI18nComplete.raw('texte8cb80e5c5cb'))}
                </span>
              </span>
              <CaretDownIcon className="text-muted-foreground size-3.5 shrink-0" />
            </Button>
          }
        />
      </SettingRow>

      <SettingRow
        label={tI18nComplete.raw('text4f503dc583f3')}
        help={
          draft.workspace
            ? WORKSPACE_MODE_HELP[draft.workspace]
            : tI18nComplete.raw('text64f405e80a8d')
        }
      >
        <Select
          value={draft.workspace ?? INHERIT}
          onValueChange={(value) =>
            set('workspace', value === INHERIT ? undefined : (value as typeof draft.workspace))
          }
        >
          <SelectTrigger
            aria-label={tI18nComplete.raw('text4f503dc583f3')}
            className="w-full"
            size="sm"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={INHERIT}>{tI18nComplete.raw('texte8cb80e5c5cb')}</SelectItem>
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
