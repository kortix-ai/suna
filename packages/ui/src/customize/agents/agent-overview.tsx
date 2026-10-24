'use client';

/**
 * The agent page's Overview tab: the agent at a glance.
 *
 * Main column, in reading order: who it is (the description and one generated
 * sentence whose nouns link to their Access view), what it does (the top of
 * its instructions), and what it may touch (one row per grant, each opening
 * its Access view). The 20rem aside holds the switches a person flips most
 * (Availability) and the facts about how it runs, who starts it and who may
 * use it. Below `lg` the aside stacks under the main column.
 *
 * One component for the editable and the read-only page. With `editor` the
 * aside's switches and selects write the shared draft; without it they show
 * their values.
 */

import type { AgentConfigBlock, AgentGrantSetV2, PermissionConfig, ProjectConfigSummary } from '@kortix/sdk';
import { capitalizeWords } from '@kortix/shared';
import {
  BookOpenTextIcon,
  CaretRightIcon,
  CommandIcon,
  CpuIcon,
  CubeIcon,
  FileTextIcon,
  GlobeIcon,
  HardDriveIcon,
  type Icon,
  KeyIcon,
  PlugsConnectedIcon,
  PuzzlePieceIcon,
  SlidersHorizontalIcon,
  SquaresFourIcon,
  TerminalWindowIcon,
  TimerIcon,
  TreeStructureIcon,
  UsersIcon,
  WrenchIcon,
} from '@phosphor-icons/react';
import { Fragment, type ReactNode } from 'react';

import { useLocale, useTranslations as useI18nTranslations } from '../../i18n';
import { agentDisplayName } from '../../internal/components/agent-mark';
import { MarkdownWithFrontmatter } from '../../markdown/markdown-frontmatter';
import { Button } from '../../primitives/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../primitives/select';
import { StatusDot } from '../../primitives/status';
import { Switch } from '../../primitives/switch';
import { Textarea } from '../../primitives/textarea';
import { UiLink as Link } from '../../providers/ui-provider';
import { AGENT_MODE_LABEL, AGENT_MODES } from '../sections/view/agent-editor-catalog';
import {
  type AgentConfigSectionKey,
  type AgentDraft,
  useLocalizedAgentConfigCatalog,
} from '../sections/view/agent-editor';
import { ACCESS_VIEWS } from './agent-tabs';

type Agent = ProjectConfigSummary['agents'][number];

/** One glyph per section: the Overview rows and the Access switcher draw the same one. */
export const SECTION_ICON: Record<AgentConfigSectionKey, Icon> = {
  overview: SquaresFourIcon,
  instructions: FileTextIcon,
  people: UsersIcon,
  basics: SlidersHorizontalIcon,
  triggers: TimerIcon,
  skills: BookOpenTextIcon,
  subagents: TreeStructureIcon,
  commands: CommandIcon,
  extensions: PuzzlePieceIcon,
  connectors: PlugsConnectedIcon,
  secrets: KeyIcon,
  apps: GlobeIcon,
  drives: HardDriveIcon,
  actions: TerminalWindowIcon,
  model: CpuIcon,
  tools: WrenchIcon,
  workspace: CubeIcon,
};

/** The grant a block holds for one Access view. Drives has none in the block. */
export function grantOf(block: AgentConfigBlock, view: AgentConfigSectionKey): AgentGrantSetV2 | undefined {
  switch (view) {
    case 'actions':
      return block.kortix_permissions ?? block.kortix_cli;
    case 'skills':
    case 'connectors':
    case 'secrets':
    case 'apps':
    case 'subagents':
    case 'commands':
    case 'extensions':
      return block[view];
    default:
      return undefined;
  }
}

/** How many ids a grant names: `all`, a number, or 0 for None. */
export function grantCount(value: AgentGrantSetV2 | undefined): number | 'all' {
  if (value === 'all') return 'all';
  return Array.isArray(value) ? value.length : 0;
}

export interface OverviewFacts {
  /** The project's size of each catalog, when known: "6 of 24". */
  totals: Partial<Record<AgentConfigSectionKey, number>>;
  /** Granted connectors whose connection needs a sign-in. */
  needsSignIn: string[];
  peopleCount?: number;
  triggerCount?: number;
}

// ─── Main column ─────────────────────────────────────────────────────────────

/** The description field, for the Instructions tab. */
export function DescriptionField({
  value,
  onChange,
  subagent,
}: {
  value: string;
  onChange: (next: string) => void;
  subagent: boolean;
}) {
  const t = useI18nTranslations('agentEditor.page');
  return (
    <section className="space-y-2">
      <h2 className="text-foreground flex flex-wrap items-baseline gap-x-2 text-sm font-medium">
        {t('description')}
        <span className="text-muted-foreground text-xs font-normal">
          {subagent ? t('descriptionHelpSubagent') : t('descriptionHelp')}
        </span>
      </h2>
      <Textarea
        aria-label={t('description')}
        value={value}
        placeholder={t('descriptionPlaceholder')}
        minHeight={44}
        className="max-w-3xl text-sm"
        onChange={(e) => onChange(e.target.value)}
      />
    </section>
  );
}

/**
 * "researcher can use 6 skills, 3 connectors and 2 secrets." Each noun links
 * to its Access view. The fastest way to read an agent.
 */
function SummarySentence({
  name,
  block,
  views,
  hrefFor,
}: {
  name: string;
  block: AgentConfigBlock;
  views: readonly AgentConfigSectionKey[];
  hrefFor: (view: AgentConfigSectionKey) => string;
}) {
  const t = useI18nTranslations('agentEditor.tabs');
  const locale = useLocale();
  const parts = views
    .filter((view) => view !== 'drives')
    .map((view) => ({ view, count: grantCount(grantOf(block, view)) }))
    .filter((part) => part.count !== 0);
  if (parts.length === 0) {
    return <p className="text-muted-foreground text-sm text-pretty">{t('summaryNone', { name })}</p>;
  }
  const words = parts.map((part) =>
    part.count === 'all' ? t(`summaryAll.${part.view}`) : t(`summaryCount.${part.view}`, { count: part.count }),
  );
  // Format with placeholders, then swap each one for its link.
  const formatted = new Intl.ListFormat(locale, { type: 'conjunction' }).format(words.map((_, i) => `\u0000${i}\u0000`));
  const pieces = formatted.split(/\u0000(\d+)\u0000/);
  return (
    <p className="text-muted-foreground text-sm text-pretty">
      {t('summaryLead', { name })}{' '}
      {pieces.map((piece, i) =>
        i % 2 === 1 ? (
          <Link
            key={i}
            href={hrefFor(parts[Number(piece)].view)}
            className="text-foreground decoration-border hover:decoration-foreground underline underline-offset-4 transition-colors"
          >
            {words[Number(piece)]}
          </Link>
        ) : (
          <Fragment key={i}>{piece}</Fragment>
        ),
      )}
      .
    </p>
  );
}

/** The top of the instructions, rendered under a fade, with Edit. */
function InstructionsPreview({ prompt, href, editable }: { prompt: string | null; href: string; editable: boolean }) {
  const t = useI18nTranslations('agentEditor.page');
  const text = prompt?.trim() ?? '';
  const words = text ? text.split(/\s+/).length : 0;
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-foreground text-sm font-medium">
          {t('instructions')}
          {words > 0 ? (
            <span className="text-muted-foreground ml-2 font-normal tabular-nums">{t('words', { count: words })}</span>
          ) : null}
        </h2>
        <Button asChild variant="outline" size="sm">
          <Link href={href}>{editable ? (words > 0 ? t('instructionsEdit') : t('instructionsWrite')) : t('instructions')}</Link>
        </Button>
      </div>
      {words > 0 ? (
        <Link
          href={href}
          aria-label={t('instructionsEdit')}
          className="bg-background hover:border-foreground/20 relative block max-h-64 overflow-hidden rounded-md border px-4 py-3 transition-colors"
        >
          <MarkdownWithFrontmatter content={text} />
          <span
            aria-hidden
            className="from-background pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t to-transparent"
          />
        </Link>
      ) : (
        <p className="text-muted-foreground rounded-md border px-4 py-3 text-sm">{t('instructionsEmpty')}</p>
      )}
    </section>
  );
}

/**
 * One row per Access view: what the agent holds there, by name, and the
 * count against the project's catalog. A connector that needs a sign-in is
 * named on its row, because a grant that cannot connect does not work.
 */
function AccessSummary({
  name,
  block,
  views,
  facts,
  hrefFor,
}: {
  name: string;
  block: AgentConfigBlock;
  views: readonly AgentConfigSectionKey[];
  facts: OverviewFacts;
  hrefFor: (view: AgentConfigSectionKey) => string;
}) {
  const t = useI18nTranslations('agentEditor.tabs');
  const tPage = useI18nTranslations('agentEditor.page');
  const catalog = useLocalizedAgentConfigCatalog();
  const labelOf = (key: AgentConfigSectionKey) => catalog.sections.find((s) => s.key === key)?.label ?? key;
  const rows = ACCESS_VIEWS.filter((view) => views.includes(view));
  return (
    <section className="space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-foreground flex flex-wrap items-baseline gap-x-2 text-sm font-medium">
          {tPage('access')}
          <span className="text-muted-foreground text-xs font-normal">{t('accessHint', { name })}</span>
        </h2>
      </div>
      <ul className="bg-background divide-border divide-y overflow-hidden rounded-md border">
        {rows.map((view) => {
          const RowIcon = SECTION_ICON[view];
          const value = grantOf(block, view);
          const count = grantCount(value);
          const total = facts.totals[view];
          const detail =
            view === 'drives'
              ? t('drivesDetail')
              : count === 'all'
                ? t('detailAll')
                : count === 0
                  ? t('detailNone')
                  : (value as string[]).join(', ');
          const valueText =
            view === 'drives'
              ? null
              : count === 'all'
                ? tPage('all')
                : count === 0
                  ? tPage('none')
                  : total !== undefined
                    ? t('countOf', { count, total })
                    : String(count);
          const warn = view === 'connectors' ? facts.needsSignIn.length : 0;
          return (
            <li key={view}>
              <Link
                href={hrefFor(view)}
                className="hover:bg-hover focus-visible:bg-hover flex items-center gap-3 px-4 py-2.5 transition-colors duration-fast focus-visible:outline-none"
              >
                <span className="bg-muted text-muted-foreground flex size-7 shrink-0 items-center justify-center rounded-sm">
                  <RowIcon aria-hidden className="size-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="text-foreground block truncate text-sm">{labelOf(view)}</span>
                  <span className="text-muted-foreground block truncate text-xs">{detail}</span>
                </span>
                {warn > 0 ? (
                  <span className="text-foreground hidden shrink-0 items-center gap-1.5 text-sm sm:flex">
                    <StatusDot tone="warning" />
                    {t('needsSignIn', { count: warn })}
                  </span>
                ) : null}
                {valueText ? (
                  <span
                    className={
                      count === 0
                        ? 'text-muted-foreground shrink-0 text-sm tabular-nums'
                        : 'text-foreground shrink-0 text-sm tabular-nums'
                    }
                  >
                    {valueText}
                  </span>
                ) : null}
                <CaretRightIcon aria-hidden className="text-muted-foreground size-3.5 shrink-0" />
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ─── Aside ───────────────────────────────────────────────────────────────────

const PROJECT_WIDE = '__project_wide__';
const INHERIT = '__inherit__';

/** A headed section of the aside: one heading, then divided rows. */
function AsideSection({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section>
      <div className="flex h-10 items-center justify-between gap-2 px-4">
        <h2 className="text-foreground text-sm font-medium">{title}</h2>
        {action}
      </div>
      <div className="divide-border divide-y border-t">{children}</div>
    </section>
  );
}

/** One aside row: label (and help) left, a control or value right. */
function AsideRow({ label, help, children }: { label: string; help?: string; children?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-2.5">
      <div className="min-w-0">
        <p className="text-foreground truncate text-sm">{label}</p>
        {help ? <p className="text-muted-foreground text-xs text-pretty">{help}</p> : null}
      </div>
      {children ? <div className="flex shrink-0 items-center">{children}</div> : null}
    </div>
  );
}

/** A row that opens another tab: its value, then a caret. */
function AsideLink({ label, value, href }: { label: string; value: ReactNode; href: string }) {
  return (
    <Link
      href={href}
      className="hover:bg-hover focus-visible:bg-hover flex items-center justify-between gap-3 px-4 py-2.5 transition-colors duration-fast focus-visible:outline-none"
    >
      <span className="text-muted-foreground shrink-0 text-sm">{label}</span>
      <span className="text-foreground flex min-w-0 items-center gap-1.5 text-sm">
        <span className="truncate">{value}</span>
        <CaretRightIcon aria-hidden className="text-muted-foreground size-3.5 shrink-0" />
      </span>
    </Link>
  );
}

function toolsValue(permission: PermissionConfig | undefined, t: ReturnType<typeof useI18nTranslations>) {
  if (permission === undefined) return t('defaultRules');
  if (typeof permission === 'string') return t('everything', { action: capitalizeWords(permission) });
  return t('rules', { count: Object.keys(permission).length });
}

function OverviewAside({
  agent,
  config,
  block,
  editor,
  facts,
  hrefs,
}: {
  agent: Agent;
  config: ProjectConfigSummary;
  block: AgentConfigBlock;
  editor?: AgentDraft;
  facts: OverviewFacts;
  hrefs: { model: string; tools: string; workspace: string; triggers: string; people: string };
}) {
  const t = useI18nTranslations('agentEditor.tabs');
  const tPage = useI18nTranslations('agentEditor.page');
  const behavior = block.behavior ?? {};
  const enabled = block.enabled !== false;
  const shown = !behavior.hidden;
  const space = block.space ?? agent.space ?? null;
  const spaces = config.spaces ?? [];
  const spaceNames = new Set(spaces.map((s) => s.name));
  const yesNo = (on: boolean) => (
    <span className="text-foreground flex items-center gap-1.5 text-sm">
      <StatusDot tone={on ? 'success' : 'neutral'} />
      {on ? t('on') : t('off')}
    </span>
  );
  const modeLabel = behavior.mode ? AGENT_MODE_LABEL[behavior.mode] : t('modeDefault');
  return (
    <div className="bg-background divide-border divide-y overflow-hidden rounded-md border">
      <AsideSection title={t('availability')}>
        <AsideRow label={t('enabled')} help={t('enabledHelp', { name: agentDisplayName(agent.name) })}>
          {editor ? (
            <Switch
              aria-label={t('enabled')}
              checked={enabled}
              onCheckedChange={(v) => editor.set('enabled', v ? undefined : false)}
            />
          ) : (
            yesNo(enabled)
          )}
        </AsideRow>
        <AsideRow label={t('showInPickers')} help={t('showInPickersHelp')}>
          {editor ? (
            <Switch
              aria-label={t('showInPickers')}
              checked={shown}
              onCheckedChange={(v) => editor.setOc('hidden', v ? undefined : true)}
            />
          ) : (
            yesNo(shown)
          )}
        </AsideRow>
        <div className="space-y-2 px-4 py-2.5">
          <p className="text-foreground text-sm">{t('whoStarts')}</p>
          {editor ? (
            <Select
              value={behavior.mode ?? INHERIT}
              onValueChange={(v) => editor.setOc('mode', v === INHERIT ? undefined : (v as (typeof AGENT_MODES)[number]))}
            >
              <SelectTrigger aria-label={t('whoStarts')} size="sm" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={INHERIT}>{t('modeDefault')}</SelectItem>
                {AGENT_MODES.map((mode) => (
                  <SelectItem key={mode} value={mode}>
                    {AGENT_MODE_LABEL[mode]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <p className="text-muted-foreground text-sm">{modeLabel}</p>
          )}
        </div>
        <div className="space-y-2 px-4 py-2.5">
          <p className="text-foreground text-sm">{t('space')}</p>
          {editor ? (
            <Select
              value={space ?? PROJECT_WIDE}
              onValueChange={(v) => editor.set('space', v === PROJECT_WIDE ? undefined : v)}
            >
              <SelectTrigger aria-label={t('space')} size="sm" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={PROJECT_WIDE}>{t('projectWide')}</SelectItem>
                {spaces.map((s) => (
                  <SelectItem key={s.name} value={s.name}>
                    # {s.label || s.name}
                  </SelectItem>
                ))}
                {space && !spaceNames.has(space) ? (
                  <SelectItem value={space}># {space}</SelectItem>
                ) : null}
              </SelectContent>
            </Select>
          ) : (
            <p className="text-muted-foreground text-sm">{space ? `# ${space}` : t('projectWide')}</p>
          )}
        </div>
      </AsideSection>

      <AsideSection title={tPage('runtime')}>
        <AsideLink
          label={t('model')}
          href={hrefs.model}
          value={behavior.model ? (behavior.model.split('/').pop() ?? behavior.model) : tPage('projectDefault')}
        />
        <AsideLink label={t('tools')} href={hrefs.tools} value={toolsValue(behavior.permission, tPage)} />
        <AsideLink label={t('workspace')} href={hrefs.workspace} value={block.sandbox ?? tPage('projectDefault')} />
      </AsideSection>

      <AsideSection title={t('use')}>
        <AsideLink
          label={t('triggers')}
          href={hrefs.triggers}
          value={facts.triggerCount === undefined ? '—' : facts.triggerCount > 0 ? tPage('triggers', { count: facts.triggerCount }) : tPage('none')}
        />
        <AsideLink
          label={t('people')}
          href={hrefs.people}
          value={facts.peopleCount === undefined ? t('manage') : facts.peopleCount > 0 ? tPage('granted', { count: facts.peopleCount }) : tPage('none')}
        />
      </AsideSection>
    </div>
  );
}

// ─── The tab ─────────────────────────────────────────────────────────────────

export function AgentOverview({
  agent,
  config,
  block,
  prompt,
  views,
  facts,
  editor,
  hrefFor,
  hrefs,
  sourcePath,
}: {
  agent: Agent;
  config: ProjectConfigSummary;
  /** The draft (editable) or the served block (read-only). */
  block: AgentConfigBlock;
  /** The instructions; null while a reader's source file loads. */
  prompt: string | null;
  views: readonly AgentConfigSectionKey[];
  facts: OverviewFacts;
  editor?: AgentDraft;
  hrefFor: (view: AgentConfigSectionKey) => string;
  hrefs: { instructions: string; model: string; tools: string; workspace: string; triggers: string; people: string };
  sourcePath: string;
}) {
  const t = useI18nTranslations('agentEditor.tabs');
  const name = agentDisplayName(agent.name);
  const description = block.behavior?.description ?? agent.description ?? '';
  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="min-w-0 space-y-8">
        <section className="space-y-2">
          <h2 className="text-foreground text-sm font-medium">{t('about')}</h2>
          {description ? (
            <p className="text-foreground max-w-3xl text-base text-pretty">{description}</p>
          ) : (
            <p className="text-muted-foreground text-sm">{t('noDescription')}</p>
          )}
          <SummarySentence name={name} block={block} views={views} hrefFor={hrefFor} />
        </section>
        <InstructionsPreview prompt={prompt} href={hrefs.instructions} editable={editor !== undefined} />
        <AccessSummary name={name} block={block} views={views} facts={facts} hrefFor={hrefFor} />
      </div>
      <div className="min-w-0 space-y-3">
        <OverviewAside agent={agent} config={config} block={block} editor={editor} facts={facts} hrefs={hrefs} />
        <p className="text-muted-foreground px-1 text-xs text-pretty">
          {t.rich('savedIn', {
            file: () => <span className="font-mono">kortix.yaml</span>,
            key: () => <span className="font-mono">agents.{agent.name}</span>,
            source: () => <span className="font-mono">{sourcePath}</span>,
          })}
        </p>
      </div>
    </div>
  );
}
