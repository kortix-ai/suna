'use client';

import { Badge } from '../../../primitives/badge';
import { Button } from '../../../primitives/button';
import { ButtonGroup } from '../../../primitives/button-group';
import { StatusDot } from '../../../primitives/status';
import { TextShimmer } from '../../../primitives/text-shimmer';
import { GenericTool } from '../generic-tool';
import {
  BasicTool,
  partError,
  partInput,
  partRawOutput,
  partStatus,
  ToolOutcomeContext,
  ToolRunningContext,
  useToolIndent,
  useToolOpen,
} from '../shared/infrastructure';
import { FoldedSection, OutputBlock } from '../shared/output-block';
import { ToolRegistry } from '../shared/registry';
import { ToolResultCard } from '../shared/result-card';
import type { ToolProps } from '../shared/types';
import { useTranslations } from '../../../i18n';
import { cn } from '../../../lib/utils';
import { UiLink } from '../../../providers/ui-provider';
import {
  ArrowRightIcon,
  ArrowSquareOutIcon,
  CalendarDotsIcon,
  CaretRightIcon,
  ChartBarIcon,
  ChatsCircleIcon,
  CheckIcon,
  HandPointingIcon,
  LockKeyIcon,
  PlugIcon,
  RobotIcon,
  UsersIcon,
  WarningIcon,
  type Icon,
} from '@phosphor-icons/react';
import { useContext, useMemo } from 'react';
import { MULTI_AGENT_ICON, multiAgentBody, runningKey } from './multi-agent-tool-bodies';
import {
  KORTIX_PLATFORM_TOOLS,
  isReadAction,
  kortixCardTool,
  kortixPlatformTool,
  multiAgentTool,
  parseKortixToolResult,
  type KortixCardChange,
  type KortixCardLink,
  type KortixCardRow,
  type KortixCardStatus,
  type KortixPlatformTool,
  type KortixToolError,
} from './kortix-tool-card';

/**
 * The card of a My Kortix platform tool (`kortix_agents`, `kortix_sessions`, …).
 *
 * The tool returns one `KortixToolResult` (`packages/api-contract/src/kortix-tool-card.ts`),
 * and the person reads its `card`: a headline, a status mark, the rows it found,
 * the settings it changed, and the links to open. The model reads `data`; this
 * card never shows it, except folded under "Show details".
 *
 * A refused action is not a failure: Kortix's permission check worked, and a
 * person can grant the permission. It reads as "Needs a permission" with the
 * people who can grant it (color.md: a refusal by design takes `kortix-orange`).
 *
 * The multi-agent tools (`send_message`, `list_agents`, `task_*`) draw a richer
 * body from the result's `data` (`multi-agent-tool-bodies.tsx`): the message and
 * whether it arrived, the agents with their state, the tasks with owner and
 * blockers.
 *
 * A result that does not parse renders as the generic tool card.
 */

type ObjectKey = 'agents' | 'sessions' | 'schedules' | 'connectors' | 'people' | 'access' | 'usage';

const TOOL_META: Record<KortixPlatformTool, { icon: Icon; object: ObjectKey }> = {
  kortix_agents: { icon: RobotIcon, object: 'agents' },
  kortix_sessions: { icon: ChatsCircleIcon, object: 'sessions' },
  kortix_schedules: { icon: CalendarDotsIcon, object: 'schedules' },
  kortix_connectors: { icon: PlugIcon, object: 'connectors' },
  kortix_people: { icon: UsersIcon, object: 'people' },
  kortix_access: { icon: LockKeyIcon, object: 'access' },
  kortix_usage: { icon: ChartBarIcon, object: 'usage' },
};

/** Row badge words that name a state with a hue (color.md status table). Any other word stays neutral. */
const SUCCESS_WORDS = new Set(['running', 'active', 'connected', 'enabled', 'done', 'live', 'merged', 'on']);
const ATTENTION_WORDS = new Set(['paused', 'expired', 'not signed in', 'disconnected', 'needs you']);

function badgeVariant(badge: string): 'success' | 'warning' | 'muted' {
  const word = badge.toLowerCase();
  if (SUCCESS_WORDS.has(word)) return 'success';
  if (ATTENTION_WORDS.has(word)) return 'warning';
  return 'muted';
}

/** Raw output for "Show details": the result pretty-printed, capped. */
const DETAILS_LIMIT = 8_000;
function detailsText(raw: string): string {
  let text = raw;
  try {
    text = JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    // keep the raw text
  }
  return text.length > DETAILS_LIMIT ? `${text.slice(0, DETAILS_LIMIT)}\n…` : text;
}

/** The card's state at the row's right edge. The glyph carries the hue; the word is for a screen reader. */
function StatusMark({ status }: { status: KortixCardStatus }) {
  const t = useTranslations('tools.kortixAction.status');
  const glyph =
    status === 'done' ? (
      <CheckIcon aria-hidden className="text-kortix-green size-3.5 shrink-0" />
    ) : status === 'running' ? (
      // The thing the tool started runs on (a session). No spinner: the call itself is over.
      <StatusDot tone="success" />
    ) : status === 'needs_you' ? (
      <HandPointingIcon weight="fill" aria-hidden className="text-kortix-yellow size-3.5 shrink-0" />
    ) : status === 'denied' ? (
      <LockKeyIcon weight="fill" aria-hidden className="text-kortix-orange size-3.5 shrink-0" />
    ) : (
      <WarningIcon weight="fill" aria-hidden className="text-kortix-red size-3.5 shrink-0" />
    );
  const label = { done: t('done'), running: t('running'), needs_you: t('needsYou'), denied: t('denied'), error: t('error') }[status];
  return (
    <span className="ml-auto flex shrink-0 items-center pl-1">
      {glyph}
      <span className="sr-only">{label}</span>
    </span>
  );
}

/** The row's words stay ink; the status mark at the right edge carries the hue. */
function CardTrigger({
  title,
  subtitle,
  live,
  status,
}: {
  title: string;
  subtitle?: string;
  live: boolean;
  status?: KortixCardStatus;
}) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden text-sm">
      {live ? (
        <TextShimmer duration={1} spread={2} className="min-w-0 truncate text-sm">
          {title}
        </TextShimmer>
      ) : (
        <span className="text-foreground min-w-0 truncate" title={title}>
          {title}
        </span>
      )}
      {subtitle && (
        <span className="text-muted-foreground min-w-0 flex-1 truncate" title={subtitle}>
          {subtitle}
        </span>
      )}
      {status && <StatusMark status={status} />}
    </div>
  );
}

const ROW_CLASS = 'flex min-w-0 items-center gap-2 rounded-sm px-2 py-1.5 text-xs';

function CardRowLine({ row }: { row: KortixCardRow }) {
  const body = (
    <>
      <span className="text-foreground min-w-0 truncate font-medium" title={row.title}>
        {row.title}
      </span>
      {row.detail ? (
        <span className="text-muted-foreground min-w-0 flex-1 truncate" title={row.detail}>
          {row.detail}
        </span>
      ) : (
        <span className="flex-1" />
      )}
      {row.badge && (
        <Badge variant={badgeVariant(row.badge)} size="sm" className="shrink-0">
          {row.badge}
        </Badge>
      )}
      {row.href && <CaretRightIcon aria-hidden className="text-muted-foreground size-3 shrink-0" />}
    </>
  );
  return row.href ? (
    <UiLink href={row.href} className={cn(ROW_CLASS, 'hover:bg-muted/40 transition-colors')}>
      {body}
    </UiLink>
  ) : (
    <div className={ROW_CLASS}>{body}</div>
  );
}

function ChangeLine({ change }: { change: KortixCardChange }) {
  const t = useTranslations('tools.kortixAction');
  return (
    <li className={ROW_CLASS}>
      <span className="text-muted-foreground shrink-0">{change.field}</span>
      {change.before === null ? (
        <>
          <Badge variant="new" size="sm" className="shrink-0">
            {t('newSetting')}
          </Badge>
          <span className="text-foreground min-w-0 truncate" title={change.after ?? ''}>
            {change.after}
          </span>
        </>
      ) : change.after === null ? (
        <>
          <span className="text-muted-foreground min-w-0 truncate line-through" title={change.before}>
            {change.before}
          </span>
          <Badge variant="muted" size="sm" className="shrink-0">
            {t('removedSetting')}
          </Badge>
        </>
      ) : (
        <>
          <span className="text-muted-foreground min-w-0 truncate" title={change.before}>
            {change.before}
          </span>
          <ArrowRightIcon aria-hidden className="text-muted-foreground size-3 shrink-0" />
          <span className="text-foreground min-w-0 truncate" title={change.after}>
            {change.after}
          </span>
        </>
      )}
    </li>
  );
}

/** "Needs a permission", then who can grant it. The brand's refusal wording when the tool could not read them. */
function DeniedNotice({ error }: { error?: KortixToolError }) {
  const t = useTranslations('tools.kortixAction');
  const grantors = error?.grantors ?? [];
  return (
    <ToolResultCard bodyClassName="space-y-1.5 px-2 py-1.5 text-xs">
      <div className="text-foreground flex items-center gap-1.5 font-medium">
        <LockKeyIcon weight="fill" aria-hidden className="text-kortix-orange size-3.5 shrink-0" />
        {t('deniedTitle')}
      </div>
      {grantors.length > 0 ? (
        <div className="space-y-1">
          <div className="text-muted-foreground">{t('grantors')}</div>
          <ul className="space-y-0.5">
            {grantors.map((grantor, index) => (
              <li key={`${grantor.name}-${index}`} className="flex min-w-0 items-center gap-1.5">
                <span className="text-foreground min-w-0 truncate">{grantor.name}</span>
                {grantor.role && (
                  <>
                    <span aria-hidden className="text-muted-foreground shrink-0">
                      ·
                    </span>
                    <span className="text-muted-foreground shrink-0">{grantor.role}</span>
                  </>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-muted-foreground">{t('grantorsUnknown')}</p>
      )}
    </ToolResultCard>
  );
}

/**
 * The card's links. An absolute `https://` link (a connector sign-in) is the card's
 * primary action and opens a new tab; in-app paths stay in the app.
 */
function CardLinks({ links }: { links: KortixCardLink[] }) {
  const t = useTranslations('tools.kortixAction');
  const indent = useToolIndent();
  const external = links.filter((link) => link.external);
  const internal = links.filter((link) => !link.external);
  const internalButtons = internal.map((link) => (
    <Button key={`${link.label}-${link.href}`} asChild variant="outline" size="xs">
      <UiLink href={link.href}>{link.label}</UiLink>
    </Button>
  ));
  return (
    <div className={cn('flex flex-wrap items-center gap-1.5', indent && 'mt-1.5', indent)}>
      {external.map((link) => (
        <Button key={`${link.label}-${link.href}`} asChild size="xs">
          <a href={link.href} target="_blank" rel="noopener noreferrer" title={t('opensInNewTab')}>
            {link.label}
            <ArrowSquareOutIcon aria-hidden className="size-3 shrink-0" />
          </a>
        </Button>
      ))}
      {internalButtons.length > 1 ? <ButtonGroup>{internalButtons}</ButtonGroup> : internalButtons}
    </div>
  );
}

function CardDetails({ raw }: { raw: string }) {
  const t = useTranslations('tools.kortixAction');
  const indent = useToolIndent();
  const text = useMemo(() => detailsText(raw), [raw]);
  return (
    <div className={cn(indent && 'mt-1.5', indent)}>
      <FoldedSection label={t('showDetails')}>
        <OutputBlock text={text} />
      </FoldedSection>
    </div>
  );
}

/** The trigger subtitle while the row is closed; open, the body says it in full. */
function SettledTrigger({
  title,
  subtitle,
  subtitleInBody,
  status,
}: {
  title: string;
  subtitle?: string;
  subtitleInBody: boolean;
  status: KortixCardStatus;
}) {
  const open = useToolOpen();
  return (
    <CardTrigger title={title} subtitle={open && subtitleInBody ? undefined : subtitle} live={false} status={status} />
  );
}

export function KortixActionTool(props: ToolProps) {
  const { call, defaultOpen, forceOpen, locked } = props;
  const t = useTranslations('tools.kortixAction');
  const tMulti = useTranslations('multiAgent.tools');
  const running = useContext(ToolRunningContext);
  const tool = kortixCardTool(call.name);
  const platform = kortixPlatformTool(call.name);
  const multi = multiAgentTool(call.name);
  const status = partStatus(call);
  const settled = status === 'completed' || status === 'error';
  const raw = status === 'error' ? (partError(call) ?? '') : partRawOutput(call);
  const result = useMemo(() => (settled ? parseKortixToolResult(raw, call.name) : null), [settled, raw, call.name]);

  if (!tool || (settled && !result)) {
    return <GenericTool call={call} defaultOpen={defaultOpen} forceOpen={forceOpen} locked={locked} />;
  }

  const ToolIcon = platform ? TOOL_META[platform].icon : MULTI_AGENT_ICON[multi!];
  const icon = <ToolIcon className="size-4 shrink-0" />;

  if (!result) {
    const title = platform
      ? t(`running.${TOOL_META[platform].object}.${isReadAction(partInput(call).action) ? 'read' : 'change'}`)
      : tMulti(`running.${runningKey(multi!)}`);
    return (
      <BasicTool
        icon={icon}
        trigger={<CardTrigger title={title} live={running} />}
        defaultOpen={defaultOpen}
        forceOpen={forceOpen}
        locked={locked}
      />
    );
  }

  const { card, error } = result;
  const denied = card.status === 'denied';
  const failure = card.status === 'error' && error && error.message && error.message !== card.title ? error.message : undefined;
  // `fail()` puts the error message in the subtitle; the open card shows it in full instead.
  const subtitleInBody = denied || (failure !== undefined && failure === card.subtitle);
  // A multi-agent result draws its own body from `data`; the card's rows would say it twice.
  const rich = multi && !denied ? multiAgentBody(multi, result) : null;
  const hasBody = denied || Boolean(failure) || Boolean(rich) || card.rows.length > 0 || card.changes.length > 0 || card.links.length > 0 || Boolean(raw);
  // What the person must see or act on opens itself: a refusal, a change, a sign-in link.
  const attention = denied || card.status === 'needs_you' || card.changes.length > 0 || card.links.some((link) => link.external);

  return (
    // The card names its own outcome (the status mark); the shared failure triangle would repeat it.
    <ToolOutcomeContext.Provider value="ok">
      <BasicTool
        icon={icon}
        trigger={<SettledTrigger title={card.title} subtitle={card.subtitle} subtitleInBody={subtitleInBody} status={card.status} />}
        defaultOpen={defaultOpen}
        forceOpen={forceOpen || attention}
        locked={locked}
      >
        {hasBody ? (
          <>
            {denied && <DeniedNotice error={error} />}
            {failure && (
              <ToolResultCard bodyClassName="px-2 py-1.5">
                <p className="text-muted-foreground text-xs wrap-break-word">{failure}</p>
              </ToolResultCard>
            )}
            {rich}
            {!rich && card.rows.length > 0 && (
              <ToolResultCard bodyClassName="py-0.5">
                <ul>
                  {card.rows.map((row, index) => (
                    <li key={`${row.title}-${index}`}>
                      <CardRowLine row={row} />
                    </li>
                  ))}
                </ul>
              </ToolResultCard>
            )}
            {card.changes.length > 0 && (
              <ToolResultCard bodyClassName="py-0.5">
                <ul>
                  {card.changes.map((change, index) => (
                    <ChangeLine key={`${change.field}-${index}`} change={change} />
                  ))}
                </ul>
              </ToolResultCard>
            )}
            {card.links.length > 0 && <CardLinks links={card.links} />}
            {raw && <CardDetails raw={raw} />}
          </>
        ) : undefined}
      </BasicTool>
    </ToolOutcomeContext.Provider>
  );
}

for (const name of KORTIX_PLATFORM_TOOLS) ToolRegistry.register(name, KortixActionTool);
// The multi-agent tools no older tool shares a name with. `task_create`, `task_list`,
// `task_get` and `task_update` register in `multi-agent-tools.tsx`, beside the older tools.
for (const name of ['send_message', 'list_agents', 'task_stop']) ToolRegistry.register(name, KortixActionTool);
