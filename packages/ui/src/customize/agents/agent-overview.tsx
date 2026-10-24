'use client';

/**
 * The agent page's Overview: the agent at a glance.
 *
 * It answers four questions in reading order, then lets the person open each
 * answer to change it:
 *
 *  1. Who is it — `AgentHero`: the mark, the name, its kind, its description.
 *  2. What does it do — `InstructionsExcerpt`: the top of its system prompt.
 *  3. What may it touch — the Access list: one row per grant, read as
 *     All / N selected / None. Other agents are least-privilege work
 *     products, so "None" is the quiet default and "All" is the row to read.
 *  4. How does it run — the Runtime and Use lists: model, tool rules,
 *     workspace, who may use it, what starts it.
 *
 * Every row is a link to its section (`?section=<key>`), so the overview is
 * also the agent's table of contents.
 */

import type { AgentGrantSetV2, PermissionConfig, ProjectConfigSummary } from '@kortix/sdk';
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
import type { ReactNode } from 'react';

import { useTranslations as useI18nTranslations } from '../../i18n';
import { AgentMark, agentDisplayName } from '../../internal/components/agent-mark';
import { MarkdownWithFrontmatter } from '../../markdown/markdown-frontmatter';
import { Button } from '../../primitives/button';
import { Textarea } from '../../primitives/textarea';
import { UiLink as Link } from '../../providers/ui-provider';
import {
  type AgentConfigSectionKey,
  useLocalizedAgentConfigCatalog,
} from '../sections/view/agent-editor';
import { agentStatus } from './agent-status';

type Agent = ProjectConfigSummary['agents'][number];

/** One glyph per section: the rail and the overview rows draw the same one. */
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

// ─── Who is it ───────────────────────────────────────────────────────────────

/**
 * The agent's identity: its mark at the large tile, its name as the detail
 * title, and one muted line that says what kind of agent it is. `children`
 * is the description: a field on the editor, a paragraph for a reader.
 */
export function AgentHero({
  agent,
  config,
  children,
}: {
  agent: Agent;
  config: ProjectConfigSummary;
  children?: ReactNode;
}) {
  const t = useI18nTranslations('agentEditor.page');
  const { isDefault, disabled } = agentStatus(agent, config);
  const mode = agent.mode?.toLowerCase();
  const kind = [
    agent.platform ? t('builtIn') : null,
    agent.platform ? null : mode === 'subagent' ? t('kindSubagent') : mode === 'all' ? t('kindBoth') : t('kindPrimary'),
    isDefault ? t('default') : null,
    disabled ? t('disabled') : null,
  ].filter((part): part is string => Boolean(part));
  return (
    <section className="space-y-5">
      <div className="flex items-center gap-4">
        <AgentMark slug={agent.name} size={42} />
        <div className="min-w-0 space-y-1">
          <h2 className="text-foreground truncate text-2xl font-semibold tracking-tight">
            {agentDisplayName(agent.name)}
          </h2>
          <p className="text-muted-foreground truncate text-sm">{kind.join(' · ')}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

/** The description as an editable field, under the hero. */
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
    <div className="space-y-2">
      <Textarea
        aria-label={t('description')}
        value={value}
        placeholder={t('descriptionPlaceholder')}
        minHeight={44}
        className="text-sm"
        onChange={(e) => onChange(e.target.value)}
      />
      <p className="text-muted-foreground text-xs text-pretty">
        {subagent ? t('descriptionHelpSubagent') : t('descriptionHelp')}
      </p>
    </div>
  );
}

// ─── What does it do ─────────────────────────────────────────────────────────

/**
 * The top of the system prompt, rendered, under a fade. The whole prompt and
 * its editor live on the Instructions section; this is the line a person reads
 * to recognise the agent.
 */
export function InstructionsExcerpt({ prompt, href }: { prompt: string; href: string }) {
  const t = useI18nTranslations('agentEditor.page');
  const words = prompt.trim() ? prompt.trim().split(/\s+/).length : 0;
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-foreground text-sm font-medium">
          {t('instructions')}
          {words > 0 ? (
            <span className="text-muted-foreground ml-2 font-normal tabular-nums">
              {t('words', { count: words })}
            </span>
          ) : null}
        </h3>
        <Button asChild variant="secondary" size="sm">
          <Link href={href}>{words > 0 ? t('instructionsEdit') : t('instructionsWrite')}</Link>
        </Button>
      </div>
      {words > 0 ? (
        <Link
          href={href}
          aria-label={t('instructionsEdit')}
          className="bg-background relative block max-h-56 overflow-hidden rounded-md border px-4 py-3"
        >
          <MarkdownWithFrontmatter content={prompt} />
          <span
            aria-hidden
            className="from-background pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t to-transparent"
          />
        </Link>
      ) : (
        <p className="text-muted-foreground py-2 text-sm">{t('instructionsEmpty')}</p>
      )}
    </section>
  );
}

// ─── What may it touch, how does it run ──────────────────────────────────────

export interface AgentOverviewFacts {
  grants: Partial<Record<'skills' | 'subagents' | 'commands' | 'extensions' | 'connectors' | 'secrets' | 'apps' | 'actions', AgentGrantSetV2 | undefined>>;
  requiredConnectors?: number;
  model?: string;
  permission?: PermissionConfig;
  sandbox?: string;
  repositoryAccess?: boolean;
  /** Undefined: the viewer cannot read the count. */
  peopleCount?: number;
  triggerCount?: number;
}

const ACCESS_ROWS = [
  'skills',
  'connectors',
  'secrets',
  'apps',
  'drives',
  'subagents',
  'commands',
  'extensions',
  'actions',
] as const satisfies readonly AgentConfigSectionKey[];
const RUNTIME_ROWS = ['model', 'tools', 'workspace'] as const satisfies readonly AgentConfigSectionKey[];
const USE_ROWS = ['people', 'triggers'] as const satisfies readonly AgentConfigSectionKey[];

/**
 * The three summary lists. A row shows only when its section exists for this
 * agent (`sections`), so a v2 manifest lists no v3 grant and a project without
 * Volumes lists no Drives.
 */
export function AgentOverviewSummary({
  facts,
  sections,
  sectionHref,
}: {
  facts: AgentOverviewFacts;
  sections: readonly AgentConfigSectionKey[];
  sectionHref: (key: AgentConfigSectionKey) => string;
}) {
  const t = useI18nTranslations('agentEditor.page');
  const catalog = useLocalizedAgentConfigCatalog();
  const labelOf = (key: AgentConfigSectionKey) =>
    catalog.sections.find((s) => s.key === key)?.label ?? key;
  const has = (key: AgentConfigSectionKey) => sections.includes(key);

  const grantValue = (value: AgentGrantSetV2 | undefined) => {
    if (value === 'all') return { text: t('all'), strong: true };
    if (Array.isArray(value) && value.length > 0)
      return { text: t('selected', { count: value.length }), strong: true };
    return { text: t('none'), strong: false };
  };

  const toolsValue = (permission: PermissionConfig | undefined) => {
    if (permission === undefined) return { text: t('defaultRules'), strong: false };
    if (typeof permission === 'string')
      return { text: t('everything', { action: capitalizeWords(permission) }), strong: true };
    return { text: t('rules', { count: Object.keys(permission).length }), strong: true };
  };

  const row = (key: AgentConfigSectionKey, value: { text: string; strong: boolean } | null, detail?: string) => (
    <SummaryRow
      key={key}
      icon={SECTION_ICON[key]}
      label={labelOf(key)}
      detail={detail}
      value={value}
      href={sectionHref(key)}
    />
  );

  const access = ACCESS_ROWS.filter(has).map((key) => {
    if (key === 'drives') return row(key, null);
    const value = grantValue(facts.grants[key]);
    const detail =
      key === 'connectors' && (facts.requiredConnectors ?? 0) > 0
        ? t('required', { count: facts.requiredConnectors ?? 0 })
        : undefined;
    return row(key, value, detail);
  });

  const runtime = RUNTIME_ROWS.filter(has).map((key) => {
    if (key === 'model')
      return row(key, {
        text: facts.model ? (facts.model.split('/').pop() ?? facts.model) : t('projectDefault'),
        strong: Boolean(facts.model),
      });
    if (key === 'tools') return row(key, toolsValue(facts.permission));
    return row(
      key,
      { text: facts.sandbox ?? t('projectDefault'), strong: Boolean(facts.sandbox) },
      facts.repositoryAccess === undefined
        ? undefined
        : facts.repositoryAccess
          ? t('repoAccess')
          : t('noRepoAccess'),
    );
  });

  const use = USE_ROWS.filter(has).map((key) => {
    if (key === 'people')
      return row(
        key,
        facts.peopleCount === undefined
          ? null
          : facts.peopleCount > 0
            ? { text: t('granted', { count: facts.peopleCount }), strong: true }
            : { text: t('none'), strong: false },
      );
    return row(
      key,
      facts.triggerCount === undefined
        ? null
        : facts.triggerCount > 0
          ? { text: t('triggers', { count: facts.triggerCount }), strong: true }
          : { text: t('none'), strong: false },
    );
  });

  return (
    <>
      <SummaryGroup title={t('access')} rows={access} />
      <SummaryGroup title={t('runtime')} rows={runtime} />
      <SummaryGroup title={t('use')} rows={use} />
    </>
  );
}

function SummaryGroup({ title, rows }: { title: string; rows: ReactNode[] }) {
  if (rows.length === 0) return null;
  return (
    <section className="space-y-3">
      <h3 className="text-foreground text-sm font-medium">{title}</h3>
      <ul className="bg-background divide-border divide-y overflow-hidden rounded-md border">{rows}</ul>
    </section>
  );
}

/** One fact: glyph, label (and an optional detail line), its value, a caret. */
function SummaryRow({
  icon: RowIcon,
  label,
  detail,
  value,
  href,
}: {
  icon: Icon;
  label: string;
  detail?: string;
  value: { text: string; strong: boolean } | null;
  href: string;
}) {
  return (
    <li>
      <Link
        href={href}
        className="hover:bg-hover focus-visible:bg-hover flex items-center gap-3 px-4 py-2.5 transition-colors duration-fast focus-visible:outline-none"
      >
        <RowIcon aria-hidden className="text-muted-foreground size-4 shrink-0" />
        <span className="min-w-0 flex-1">
          <span className="text-foreground block truncate text-sm">{label}</span>
          {detail ? <span className="text-muted-foreground block truncate text-xs">{detail}</span> : null}
        </span>
        {value ? (
          <span
            className={
              value.strong
                ? 'text-foreground shrink-0 truncate text-sm tabular-nums'
                : 'text-muted-foreground shrink-0 truncate text-sm tabular-nums'
            }
          >
            {value.text}
          </span>
        ) : null}
        <CaretRightIcon aria-hidden className="text-muted-foreground size-3.5 shrink-0" />
      </Link>
    </li>
  );
}
