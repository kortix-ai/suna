'use client';

import type { Agent, FlatModel, ProviderListResponse } from '@kortix/sdk/react';
import { isMyKortixAgentName } from '@kortix/shared';
import {
  ArrowCounterClockwiseIcon,
  CaretDownIcon,
  CaretRightIcon,
  CheckIcon,
  CpuIcon,
  GaugeIcon,
  MagnifyingGlassIcon,
} from '@phosphor-icons/react';
import { useCallback, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

import { useTranslations } from '../../../i18n';
import { AgentMark } from '../../../internal/components/agent-mark';
import { cn } from '../../../lib/utils';
import { Button } from '../../../primitives/button';
import Hint from '../../../primitives/hint';
import { InputGroupSearch, InputGroupSearchIcon, InputGroupSearchInput } from '../../../primitives/input-group';
import Loading from '../../../primitives/loading';
import { MENU_INDICATOR, MENU_INDICATOR_ICON, MENU_LABEL, MENU_SEPARATOR, menuRow } from '../../../primitives/menu-recipe';
import { Popover, PopoverContent, PopoverTrigger } from '../../../primitives/popover';
import { ModelSelector, type ModelDefaultControls } from '../../models/model-selector';
import type { SessionOverrideRow } from '../../overrides/session-overrides-control';
import { AgentSelector, resolveDisplayedAgentName, useComposerAgentChoices } from '../agent-selector';
import { EffortIcon, effortLabel, reasoningEffortChoices } from '../reasoning-effort-selector';
import { useChatInputOverrides } from './chat-input-overrides';
import {
  chatInputAgents,
  chatInputSummary,
  modelIsOverridden,
  sameModel,
  type ChatInputModelKey,
  type ChatInputOverride,
} from './chat-input-summary';

/** Same threshold as `AgentSelector`: past six agents scanning turns into scrolling. */
const SEARCH_MIN_AGENTS = 7;

/** Every element the arrow keys walk, in DOM order. */
const NAV_ATTR = 'data-chat-input-nav';

export type ChatInputRowId = 'model' | 'effort' | (string & {});

export interface ChatInputControlProps {
  /** Already filtered to the composer's primary agents. */
  agents: Agent[];
  selectedAgent: string | null;
  onAgentChange?: (agentName: string | null) => void;
  /** The agent is fixed (a DM): the panel names `selectedAgent`, offers no agent list, and keeps only the settings. */
  agentLocked?: boolean;
  /** Why there is nothing to pick. See `AgentSelector.unavailableHint`. */
  unavailableHint?: string | null;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** The row that opens expanded: the `/` palette's "Switch model" and "Set reasoning effort". */
  initialRow?: ChatInputRowId | null;
  /** Caps the agent name on the trigger. */
  triggerLabelClassName?: string;

  showModel: boolean;
  models: FlatModel[];
  modelsLoading?: boolean;
  selectedModel: ChatInputModelKey | null;
  /** What the agent runs on with no override. See `inheritedModelFor`. */
  inheritedModel?: ChatInputModelKey | null;
  onModelChange?: (model: ChatInputModelKey | null) => void;
  providers?: ProviderListResponse;
  modelDefaultControls?: ModelDefaultControls;
  projectId?: string;

  variants: string[];
  selectedVariant: string | null;
  onVariantChange?: (variant: string | null) => void;
}

interface ControlRow {
  id: ChatInputRowId;
  name: string;
  icon: SessionOverrideRow['icon'];
  value: string;
  overridden: boolean;
  onReset?: () => void;
  description?: string;
  editor: ReactNode;
}

/**
 * The `chat_input` flag's composer control: the agent and every setting a
 * session can override, behind one trigger.
 *
 * Closed, it names the agent and what overrides it ("My Kortix · Auto",
 * "My Kortix · GLM 5.3 Flash · High", "My Kortix · 2 overrides" — see
 * `chat-input-summary.ts`). Open, the agent list comes first, then one row per
 * setting this session may override. A row reads "Auto (from <agent>)" until
 * something overrides it, expands in place to the setting's existing editor,
 * and carries a one-click "Reset to auto".
 *
 * It owns no setting. Agent, model and effort write through the composer's
 * own handlers (the same ones the three pickers call with the flag off);
 * secrets, provider keys and the sandbox are the rows `SessionOverridesToolbar`
 * publishes, with its drafts and its Save. Picking another agent therefore
 * resets what that agent does not allow exactly as before: the model is kept
 * per agent, and the scope draft is re-read under the new agent's grant.
 */
export function ChatInputControl({
  agents,
  selectedAgent,
  onAgentChange,
  agentLocked = false,
  unavailableHint,
  open: openProp,
  onOpenChange,
  initialRow = null,
  triggerLabelClassName,
  showModel,
  models,
  modelsLoading,
  selectedModel,
  inheritedModel,
  onModelChange,
  providers,
  modelDefaultControls,
  projectId,
  variants,
  selectedVariant,
  onVariantChange,
}: ChatInputControlProps) {
  const t = useTranslations('threads');
  const tHardcodedUi = useTranslations('hardcodedUi');
  const tPooled = useTranslations('pooledSecrets');
  const overrides = useChatInputOverrides();
  const { primaryAgents, label } = useComposerAgentChoices(agents);

  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = openProp ?? uncontrolledOpen;
  const saving = overrides?.saving ?? false;
  const setOpen = useCallback(
    (next: boolean) => {
      // A save in flight holds the panel open: closing would hide its result.
      if (!next && saving) return;
      if (openProp === undefined) setUncontrolledOpen(next);
      onOpenChange?.(next);
    },
    [onOpenChange, openProp, saving],
  );

  const [expanded, setExpanded] = useState<ChatInputRowId | null>(null);
  const [search, setSearch] = useState('');
  // Each open starts collapsed, or on the row the `/` palette asked for.
  // Adjusted during render (React's "storing information from previous
  // renders"), not in an effect, so the first open frame already shows it.
  const [seen, setSeen] = useState({ open, initialRow });
  if (seen.open !== open || seen.initialRow !== initialRow) {
    setSeen({ open, initialRow });
    if (open) setExpanded(initialRow);
    else setSearch('');
  }

  // A fixed agent (a DM): name it and offer no other.
  const agentFixed = agentLocked;
  const agentChoice = chatInputAgents(
    primaryAgents.map((agent) => agent.name),
    agentFixed ? selectedAgent : (resolveDisplayedAgentName(primaryAgents, selectedAgent) ?? null),
    agentFixed,
    isMyKortixAgentName,
  );
  const displayedName = agentChoice.name ?? undefined;
  const agentLabel = displayedName ? label(displayedName) : 'Agent';
  const autoFrom = t('chatInputAutoFrom', { agent: agentLabel });

  const effortChoices = useMemo(() => reasoningEffortChoices(variants, !!onVariantChange), [variants, onVariantChange]);
  const currentEffort = selectedVariant && effortChoices.includes(selectedVariant) ? selectedVariant : null;
  const currentModel = models.find((model) => sameModel(model, selectedModel));
  const modelOverridden = showModel && modelIsOverridden(selectedModel, inheritedModel);
  const inheritedOffered = !!inheritedModel && models.some((model) => sameModel(model, inheritedModel));

  const rows = useMemo<ControlRow[]>(() => {
    const list: ControlRow[] = [];
    if (showModel && onModelChange) {
      list.push({
        id: 'model',
        name: t('chatInputModel'),
        icon: CpuIcon,
        value: modelOverridden ? (currentModel?.modelName ?? selectedModel?.modelID ?? t('noModel')) : autoFrom,
        overridden: modelOverridden,
        onReset: modelOverridden && inheritedOffered && inheritedModel
          ? () => onModelChange(inheritedModel)
          : undefined,
        editor: (
          <ModelSelector
            appearance="field"
            models={models}
            modelsLoading={modelsLoading}
            selectedModel={selectedModel}
            onSelect={onModelChange}
            providers={providers}
            defaultControls={modelDefaultControls}
            projectId={projectId}
            offerProviderAccounts
          />
        ),
      });
    }
    if (effortChoices.length > 0 && onVariantChange) {
      list.push({
        id: 'effort',
        name: t('chatInputEffort'),
        icon: GaugeIcon,
        value: currentEffort ? effortLabel(currentEffort) : autoFrom,
        overridden: currentEffort !== null,
        onReset: currentEffort !== null ? () => onVariantChange(null) : undefined,
        editor: (
          <div role="radiogroup" aria-label={t('thinkingEffort')} className="flex flex-col gap-px">
            {[null, ...effortChoices].map((value) => {
              const checked = value === currentEffort;
              return (
                <button
                  key={value ?? 'auto'}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  {...{ [NAV_ATTR]: '' }}
                  onClick={() => onVariantChange(value)}
                  className={menuRow('sm', 'default', checked ? 'text-foreground' : undefined)}
                >
                  <EffortIcon value={value} className="size-4 shrink-0" />
                  <span className="min-w-0 flex-1 truncate text-left">
                    {value ? effortLabel(value) : t('auto')}
                  </span>
                  <span className={MENU_INDICATOR}>
                    {checked ? <CheckIcon className={MENU_INDICATOR_ICON} /> : null}
                  </span>
                </button>
              );
            })}
          </div>
        ),
      });
    }
    for (const row of overrides?.rows ?? []) {
      const overridden = row.overridden === true;
      list.push({
        id: row.id,
        name: row.name,
        icon: row.icon,
        value: !overridden && row.inheritsFromAgent ? autoFrom : row.summary,
        overridden,
        onReset: overridden && overrides ? () => overrides.onResetRow(row.id) : undefined,
        description: row.description,
        editor: row.editor,
      });
    }
    return list;
  }, [
    autoFrom,
    currentEffort,
    currentModel?.modelName,
    effortChoices,
    inheritedModel,
    inheritedOffered,
    modelDefaultControls,
    modelOverridden,
    models,
    modelsLoading,
    onModelChange,
    onVariantChange,
    overrides,
    projectId,
    providers,
    selectedModel,
    showModel,
    t,
  ]);

  const summary = chatInputSummary(
    rows
      .filter((row) => row.overridden)
      .map((row): ChatInputOverride => ({
        id: row.id,
        value: row.value,
        glanceable: row.id === 'model' || row.id === 'effort',
      })),
  );
  const summaryText =
    summary.kind === 'auto'
      ? t('auto')
      : summary.kind === 'values'
        ? summary.values.join(' · ')
        : t('chatInputOverrideCount', { count: summary.count });

  const offeredKey = agentChoice.offered.join('\n');
  const filteredAgents = useMemo(() => {
    const query = search.toLowerCase().trim();
    // `chatInputAgents` orders them (My Kortix first) and offers none for a fixed agent.
    const offered = offeredKey ? offeredKey.split('\n') : [];
    const list = offered.flatMap((name) => primaryAgents.filter((agent) => agent.name === name));
    return query
      ? list.filter(
          (agent) =>
            agent.name.toLowerCase().includes(query) ||
            label(agent.name).toLowerCase().includes(query) ||
            (agent.description ?? '').toLowerCase().includes(query),
        )
      : list;
  }, [label, offeredKey, primaryAgents, search]);

  const panelRef = useRef<HTMLDivElement>(null);
  const onPanelKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End'];
    if (!keys.includes(event.key)) return;
    const target = event.target as HTMLElement;
    // Only the panel's own rows and the agent search walk. An editor inside
    // an expanded row (a select, a checkbox list) keeps its own arrow keys.
    const searchField = target.dataset.chatInputSearch !== undefined;
    if (!target.hasAttribute(NAV_ATTR) && !searchField) return;
    if (searchField && (event.key === 'Home' || event.key === 'End')) return;
    const items = Array.from(panelRef.current?.querySelectorAll<HTMLElement>(`[${NAV_ATTR}]`) ?? []).filter(
      (item) => !item.hasAttribute('disabled'),
    );
    if (items.length === 0) return;
    event.preventDefault();
    const index = items.indexOf(target);
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : event.key === 'ArrowDown'
            ? (index + 1) % items.length
            : (index <= 0 ? items.length : index) - 1;
    items[next]?.focus();
  }, []);

  /*
    Nothing to pick: the agent picker's own inert trigger, with its reason.
    Model and effort have no agent to inherit from and the send is refused
    (see `composer-agent-access.ts`), so there is nothing else to show.
  */
  if (primaryAgents.length === 0 && !(agentFixed && displayedName)) {
    return (
      <AgentSelector
        agents={primaryAgents}
        selectedAgent={selectedAgent}
        onSelect={onAgentChange ?? (() => {})}
        triggerLabelClassName={triggerLabelClassName}
        unavailableHint={unavailableHint}
      />
    );
  }

  const expandedRow = rows.find((row) => row.id === expanded);
  const showSave = !!overrides && !!expandedRow && overrides.saveRowIds.includes(expandedRow.id);
  const saveAndClose = async () => {
    if (!overrides) return;
    const saved = await overrides.onSave();
    if (saved) setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={`${t('chatInput')}: ${agentLabel} · ${summaryText}`}
          className="text-muted-foreground data-[state=open]:text-foreground min-w-0 rounded-lg hit-area-y-3"
        >
          <AgentMark slug={displayedName ?? agentLabel} />
          <span className={cn('max-w-[7rem] truncate', triggerLabelClassName)}>{agentLabel}</span>
          <span aria-hidden>·</span>
          <span className="max-w-[12rem] min-w-0 truncate">{summaryText}</span>
          <CaretDownIcon
            className={cn('size-3 shrink-0 transition-transform duration-moderate ease-out', open && 'rotate-180')}
          />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        aria-label={t('chatInput')}
        side="top"
        align="start"
        sideOffset={8}
        collisionPadding={12}
        className="w-[min(380px,calc(100vw-1.5rem))] overflow-hidden p-0"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          const panel = panelRef.current;
          const target =
            panel?.querySelector<HTMLElement>('[data-chat-input-search]') ??
            panel?.querySelector<HTMLElement>(`[${NAV_ATTR}][aria-checked="true"]`) ??
            panel?.querySelector<HTMLElement>(`[${NAV_ATTR}]`);
          target?.focus();
        }}
        onEscapeKeyDown={(event) => {
          if (saving) event.preventDefault();
        }}
        // The model picker and the editors' selects open in their own portals.
        // Radix counts those as outside, and would close this panel under the cursor.
        onInteractOutside={(event) => {
          const target = event.target as HTMLElement | null;
          if (saving || target?.closest('[data-radix-popper-content-wrapper]')) event.preventDefault();
        }}
      >
        <div
          ref={panelRef}
          onKeyDown={onPanelKeyDown}
          // Radix reports the room it has. Without the cap the panel outgrows
          // the gap above the composer on a 480px-tall window.
          className="flex max-h-[min(36rem,var(--radix-popover-content-available-height,36rem))] flex-col"
        >
          <div className="min-h-0 flex-1 overflow-y-auto p-1">
            {agentFixed ? null : <p className={MENU_LABEL}>{t('chatInputAgent')}</p>}
            {!agentFixed && primaryAgents.length >= SEARCH_MIN_AGENTS ? (
              <InputGroupSearch className="px-1 pb-1">
                <InputGroupSearchIcon>
                  <MagnifyingGlassIcon />
                </InputGroupSearchIcon>
                <InputGroupSearchInput
                  size="sm"
                  data-chat-input-search=""
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder={tHardcodedUi.raw(
                    'componentsSessionSessionChatInput.line231JsxAttrPlaceholderSearchAgents',
                  )}
                />
              </InputGroupSearch>
            ) : null}
            {agentFixed ? null : (
            <div role="radiogroup" aria-label={t('chatInputAgent')} className="flex flex-col gap-px">
              {filteredAgents.map((agent) => {
                const checked = agent.name === displayedName;
                return (
                  <button
                    key={agent.name}
                    type="button"
                    role="radio"
                    aria-checked={checked}
                    {...{ [NAV_ATTR]: '' }}
                    onClick={() => onAgentChange?.(agent.name)}
                    className={menuRow('md', 'default', checked ? 'bg-primary/[0.06] text-foreground' : undefined)}
                  >
                    <AgentMark slug={agent.name} />
                    <span className="min-w-0 flex-1 truncate text-left">{label(agent.name)}</span>
                    <span className={MENU_INDICATOR}>
                      {checked ? <CheckIcon className="text-foreground size-4" /> : null}
                    </span>
                  </button>
                );
              })}
              {filteredAgents.length === 0 ? (
                <p className="text-muted-foreground px-2 py-3 text-xs">
                  {tHardcodedUi.raw('componentsSessionSessionChatInput.line273JsxTextNoAgentsMatchLdquo')}
                  {search.trim()}
                  {tHardcodedUi.raw('componentsSessionSessionChatInput.line273JsxTextRdquo')}
                </p>
              ) : null}
            </div>
            )}

            {rows.length > 0 ? (
              <>
                {agentFixed ? null : <div className={MENU_SEPARATOR} />}
                <p className={MENU_LABEL}>{t('chatInputSettings')}</p>
                <ul className="flex flex-col gap-px">
                  {rows.map((row) => (
                    <ChatInputRow
                      key={row.id}
                      row={row}
                      expanded={row.id === expanded}
                      disabled={saving}
                      resetLabel={t('chatInputResetToAuto')}
                      onToggle={() => setExpanded((current) => (current === row.id ? null : row.id))}
                    />
                  ))}
                </ul>
              </>
            ) : null}
            {overrides?.notice && showSave ? <div className="px-2 pt-2">{overrides.notice}</div> : null}
          </div>

          {overrides?.error ? (
            <p role="alert" className="text-destructive px-3 py-2 text-xs">
              {overrides.error}
            </p>
          ) : null}
          {showSave && overrides ? (
            <div className="border-border flex items-center justify-between gap-3 border-t px-3 py-2">
              <p className="text-muted-foreground text-xs text-pretty" aria-live="polite">
                {overrides.pendingNote ?? tHardcodedUi.raw('i18nComplete.text26ee1166df63')}
              </p>
              <Button
                type="button"
                size="sm"
                disabled={saving || overrides.saveDisabled}
                onClick={() => void saveAndClose()}
              >
                {saving ? <Loading className="size-3.5 shrink-0" /> : null}
                {saving ? tPooled('saving') : tPooled('saveChanges')}
              </Button>
            </div>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function ChatInputRow({
  row,
  expanded,
  disabled,
  resetLabel,
  onToggle,
}: {
  row: ControlRow;
  expanded: boolean;
  disabled: boolean;
  resetLabel: string;
  onToggle: () => void;
}) {
  const RowIcon = row.icon;
  const Caret = expanded ? CaretDownIcon : CaretRightIcon;
  return (
    <li>
      <div className="flex items-center gap-0.5">
        <button
          type="button"
          aria-expanded={expanded}
          {...{ [NAV_ATTR]: '' }}
          onClick={onToggle}
          className={menuRow('md', 'default', 'min-w-0 flex-1')}
        >
          <RowIcon className="text-muted-foreground size-4" />
          <span className="text-foreground shrink-0">{row.name}</span>
          <span
            className={cn(
              'ml-auto min-w-0 truncate text-right text-xs font-normal',
              row.overridden ? 'text-foreground' : 'text-muted-foreground',
            )}
          >
            {row.value}
          </span>
          <Caret className="text-muted-foreground size-3 shrink-0" />
        </button>
        {row.onReset ? (
          <Hint side="top" label={resetLabel}>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={`${resetLabel}: ${row.name}`}
              disabled={disabled}
              {...{ [NAV_ATTR]: '' }}
              onClick={row.onReset}
              className="text-muted-foreground hover:text-foreground shrink-0"
            >
              <ArrowCounterClockwiseIcon className="size-3.5" />
            </Button>
          </Hint>
        ) : null}
      </div>
      {expanded ? (
        <div className="px-2 pt-1 pb-2">
          {row.description ? (
            <p className="text-muted-foreground mb-2 text-xs text-pretty">{row.description}</p>
          ) : null}
          {row.editor}
        </div>
      ) : null}
    </li>
  );
}
