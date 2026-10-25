'use client';

/**
 * The agent page's Overview tab: the agent at a glance.
 *
 * Main column, in reading order: who it is (the description and one generated
 * sentence whose nouns link to their Access view), what it does (its
 * instructions, edited in place as a formatted document), and what it may
 * touch (one row per grant, each opening its Access view). The description
 * and the instructions write the page's draft in place; there is no
 * separate editor. The 20rem aside holds the switches a person flips most
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
import { Fragment, type ReactNode, useState } from 'react';

import { useLocale, useTranslations as useI18nTranslations } from '../../i18n';
import { agentDisplayName } from '../../internal/components/agent-mark';
import { cn } from '../../internal/lib/utils';
import { Input } from '../../primitives/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '../../primitives/select';
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
import { useGrantLabel } from './agent-access-text';
import { AgentInstructions } from './agent-instructions';
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

/**
 * The description, edited in place: the text is the control. Click it (or
 * the empty line) and it becomes a field; Enter or leaving keeps the edit in
 * the draft, Escape puts back what was there.
 */
function AboutDescription({
  value,
  onChange,
  subagent,
}: {
  value: string;
  onChange?: (next: string) => void;
  subagent: boolean;
}) {
  const t = useI18nTranslations('agentEditor.page');
  const tTabs = useI18nTranslations('agentEditor.tabs');
  const [editing, setEditing] = useState<string | null>(null);
  if (!onChange) {
    return value ? (
      <p className="text-foreground max-w-3xl text-base text-pretty">{value}</p>
    ) : (
      <p className="text-muted-foreground text-sm">{tTabs('noDescription')}</p>
    );
  }
  if (editing !== null) {
    const finish = (keep: boolean) => {
      if (!keep) onChange(editing);
      setEditing(null);
    };
    return (
      // The field takes the text's box: the same inset and line, so nothing moves.
      <div className="-mx-3 max-w-3xl space-y-1.5">
        <Textarea
          autoFocus
          aria-label={t('description')}
          value={value}
          placeholder={t('descriptionPlaceholder')}
          minHeight={44}
          className="text-base font-normal"
          onChange={(e) => onChange(e.target.value.replace(/\n/g, ' '))}
          onBlur={() => finish(true)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              finish(true);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              finish(false);
            }
          }}
        />
        <p className="text-muted-foreground px-3 text-xs text-pretty">
          {subagent ? t('descriptionHelpSubagent') : t('descriptionHelp')}
        </p>
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={() => setEditing(value)}
      aria-label={t('description')}
      className={cn(
        'hover:bg-hover focus-visible:bg-hover -mx-3 block max-w-3xl rounded-md border border-transparent px-3 py-2 text-left text-pretty transition-colors duration-fast focus-visible:outline-none',
        value ? 'text-foreground text-base' : 'text-muted-foreground text-sm',
      )}
    >
      {value || t('descriptionPlaceholder')}
    </button>
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
  hrefFor: (view: AgentConfigSectionKey) => string | null;
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
          (() => {
            const href = hrefFor(parts[Number(piece)].view);
            return href ? (
              <Link
                key={i}
                href={href}
                className="text-foreground decoration-border hover:decoration-foreground underline underline-offset-4 transition-colors"
              >
                {words[Number(piece)]}
              </Link>
            ) : (
              <span key={i} className="text-foreground">
                {words[Number(piece)]}
              </span>
            );
          })()
        ) : (
          <Fragment key={i}>{piece}</Fragment>
        ),
      )}
      .
    </p>
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
  hrefFor: (view: AgentConfigSectionKey) => string | null;
}) {
  const t = useI18nTranslations('agentEditor.tabs');
  const tPage = useI18nTranslations('agentEditor.page');
  const grantLabel = useGrantLabel();
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
          const valueText = view === 'drives' ? null : grantLabel(value, total);
          const warn = view === 'connectors' ? facts.needsSignIn.length : 0;
          const href = hrefFor(view);
          const content = (
            <>
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
              {href ? <CaretRightIcon aria-hidden className="text-muted-foreground size-3.5 shrink-0" /> : null}
            </>
          );
          return (
            <li key={view}>
              {href ? (
                <Link
                  href={href}
                  className="hover:bg-hover focus-visible:bg-hover flex items-center gap-3 px-4 py-2.5 transition-colors duration-fast focus-visible:outline-none"
                >
                  {content}
                </Link>
              ) : (
                <div className="flex items-center gap-3 px-4 py-2.5">{content}</div>
              )}
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
const NEW_SPACE = '__new_space__';

/** A space slug from what a person typed: the API's `SPACE_SLUG_RE` shape. */
export function spaceSlug(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
}

/**
 * The Space select's "New space…": an inline field for a space kortix.yaml
 * does not declare yet. Enter keeps it (as a slug), Escape or an empty value
 * goes back to the select.
 */
function NewSpaceInput({ onDone }: { onDone: (slug: string | null) => void }) {
  const t = useI18nTranslations('agentEditor.tabs');
  const [value, setValue] = useState('');
  return (
    <Input
      autoFocus
      size="sm"
      aria-label={t('newSpace')}
      placeholder={t('newSpacePlaceholder')}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => onDone(spaceSlug(value) || null)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          onDone(spaceSlug(value) || null);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          onDone(null);
        }
      }}
    />
  );
}

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

const ASIDE_LINK =
  'hover:bg-hover focus-visible:bg-hover flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left transition-colors duration-fast focus-visible:outline-none';

/** A row that opens another tab (`href`) or a dialog (`onClick`): its value, then a caret. */
function AsideLink({
  label,
  value,
  href,
  onClick,
}: {
  label: string;
  value: ReactNode;
  href?: string;
  onClick?: () => void;
}) {
  const content = (
    <>
      <span className="text-muted-foreground shrink-0 text-sm">{label}</span>
      <span className="text-foreground flex min-w-0 items-center gap-1.5 text-sm">
        <span className="truncate">{value}</span>
        <CaretRightIcon aria-hidden className="text-muted-foreground size-3.5 shrink-0" />
      </span>
    </>
  );
  return href ? (
    <Link href={href} className={ASIDE_LINK}>
      {content}
    </Link>
  ) : (
    <button type="button" onClick={onClick} className={ASIDE_LINK}>
      {content}
    </button>
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
  onOpenShare,
}: {
  agent: Agent;
  config: ProjectConfigSummary;
  block: AgentConfigBlock;
  editor?: AgentDraft;
  facts: OverviewFacts;
  hrefs: { model: string; tools: string; workspace: string; triggers: string };
  onOpenShare?: () => void;
}) {
  const t = useI18nTranslations('agentEditor.tabs');
  const tPage = useI18nTranslations('agentEditor.page');
  const behavior = block.behavior ?? {};
  const enabled = block.enabled !== false;
  const shown = !behavior.hidden;
  // Editable: the draft alone, so choosing Project-wide shows Project-wide
  // (the save drops the key, which clears it). Read-only: the served block,
  // which already carries the agent's space.
  const space = (editor ? block.space : (block.space ?? agent.space)) || null;
  const [addingSpace, setAddingSpace] = useState(false);
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
            addingSpace ? (
              <NewSpaceInput
                onDone={(slug) => {
                  setAddingSpace(false);
                  if (slug) editor.set('space', slug);
                }}
              />
            ) : (
            <Select
              value={space ?? PROJECT_WIDE}
              onValueChange={(v) => {
                if (v === NEW_SPACE) return setAddingSpace(true);
                editor.set('space', v === PROJECT_WIDE ? undefined : v);
              }}
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
                <SelectSeparator />
                <SelectItem value={NEW_SPACE}>{t('newSpace')}</SelectItem>
              </SelectContent>
            </Select>
            )
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
        {onOpenShare ? (
          <AsideLink
            label={t('people')}
            onClick={onOpenShare}
            value={facts.peopleCount === undefined ? t('manage') : facts.peopleCount > 0 ? tPage('granted', { count: facts.peopleCount }) : tPage('none')}
          />
        ) : null}
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
  onOpenShare,
  onAskMyKortix,
  focusInstructions = false,
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
  hrefFor: (view: AgentConfigSectionKey) => string | null;
  hrefs: { model: string; tools: string; workspace: string; triggers: string };
  sourcePath: string;
  /** Opens the header's Share dialog; absent for a viewer who cannot manage people. */
  onOpenShare?: () => void;
  onAskMyKortix?: () => void;
  /** Unfold the instructions with the cursor in them (the old Instructions tab link). */
  focusInstructions?: boolean;
}) {
  const t = useI18nTranslations('agentEditor.tabs');
  const name = agentDisplayName(agent.name);
  // Editable: the draft alone, so clearing the description shows it cleared.
  const description = (editor ? editor.oc.description : (block.behavior?.description ?? agent.description)) ?? '';
  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="min-w-0 space-y-8">
        <section className="space-y-2">
          <h2 className="text-foreground text-sm font-medium">{t('about')}</h2>
          <AboutDescription
            value={description}
            onChange={editor ? (next) => editor.setOc('description', next) : undefined}
            subagent={(editor?.oc.mode ?? block.behavior?.mode) === 'subagent'}
          />
          <SummarySentence name={name} block={block} views={views} hrefFor={hrefFor} />
        </section>
        <AgentInstructions
          value={prompt}
          onChange={editor ? (next) => editor.setOc('prompt', next) : undefined}
          onAskMyKortix={onAskMyKortix}
          autoFocus={focusInstructions}
        />
        <AccessSummary name={name} block={block} views={views} facts={facts} hrefFor={hrefFor} />
      </div>
      <div className="min-w-0 space-y-3">
        <OverviewAside
          agent={agent}
          config={config}
          block={block}
          editor={editor}
          facts={facts}
          hrefs={hrefs}
          onOpenShare={onOpenShare}
        />
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
