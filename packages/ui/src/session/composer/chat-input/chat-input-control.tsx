'use client';

import type { Agent, FlatModel, ProviderListResponse } from '@kortix/sdk/react';
import { isMyKortixAgentName } from '@kortix/shared';
import { CaretDownIcon, CaretRightIcon, CheckIcon, MagnifyingGlassIcon, XIcon } from '@phosphor-icons/react';
import { useCallback, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

import { useTranslations } from '../../../i18n';
import { AgentMark } from '../../../internal/components/agent-mark';
import { cn } from '../../../lib/utils';
import { Button } from '../../../primitives/button';
import Hint from '../../../primitives/hint';
import { InputGroupSearch, InputGroupSearchIcon, InputGroupSearchInput } from '../../../primitives/input-group';
import Loading from '../../../primitives/loading';
import { MENU_INDICATOR, MENU_INDICATOR_ICON, menuRow } from '../../../primitives/menu-recipe';
import { Popover, PopoverContent, PopoverTrigger } from '../../../primitives/popover';
import { ModelSelector, type ModelDefaultControls } from '../../models/model-selector';
import type { SessionOverrideRow } from '../../overrides/session-overrides-control';
import { AgentSelector, resolveDisplayedAgentName, useComposerAgentChoices } from '../agent-selector';
import { EffortIcon, effortLabel, reasoningEffortChoices } from '../reasoning-effort-selector';
import { useChatInputOverrides } from './chat-input-overrides';
import { chatInputAgents, chatInputTriggerParts, modelIsOverridden, sameModel, type ChatInputModelKey } from './chat-input-summary';

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

/** One "More settings" row: secrets, provider keys, sandbox, files. */
interface ExtraRow {
  id: string;
  name: string;
  icon: SessionOverrideRow['icon'];
  value: string;
  overridden: boolean;
  onReset?: () => void;
  description?: string;
  editor: ReactNode;
}

/** A pill whose trigger is another component's button (the model picker): the arrow keys still reach it. */
const PILL_ATTR = 'data-chat-input-pill';
const NAV_SELECTOR = `[${NAV_ATTR}], [${PILL_ATTR}] > button`;

function isNavItem(element: HTMLElement): boolean {
  return element.hasAttribute(NAV_ATTR) || element.parentElement?.hasAttribute(PILL_ATTR) === true;
}

/**
 * The `chat_input` flag's composer control: the agent, its model and its
 * effort behind one trigger, and every other session override one step away.
 *
 * Closed, it names the agent and the model ("My Kortix · GLM 5.3 Flash"),
 * plus the effort when it is overridden and a count of the other overrides
 * (`chatInputTriggerParts`). Open, it is one compact panel:
 *
 *   - the agents (none when the agent is fixed: a DM);
 *   - a hairline, then two pills: the model (the model picker's own trigger)
 *     and the effort (its choices open in place). An overridden pill carries
 *     an × that resets it to the agent's default;
 *   - "More settings", collapsed: secrets, provider keys, sandbox and files,
 *     each expanding in place to its existing editor. "More settings · N"
 *     says how many of them are overridden.
 *
 * It owns no setting. Agent, model and effort write through the composer's
 * own handlers (the same ones the three pickers call with the flag off);
 * secrets, provider keys and the sandbox are the rows `SessionOverridesToolbar`
 * publishes, with its drafts and its Save. Picking another agent therefore
 * resets what that agent does not allow exactly as before.
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

  // What is open inside the panel: the effort choices, "More settings", one of its rows, the model picker.
  const [effortOpen, setEffortOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  // Each open starts collapsed, or on the control the `/` palette asked for.
  // Adjusted during render (React's "storing information from previous
  // renders"), not in an effect, so the first open frame already shows it.
  const [seen, setSeen] = useState({ open, initialRow });
  if (seen.open !== open || seen.initialRow !== initialRow) {
    setSeen({ open, initialRow });
    setEffortOpen(open && initialRow === 'effort');
    setModelOpen(open && initialRow === 'model');
    const extra = open && initialRow && initialRow !== 'model' && initialRow !== 'effort' ? initialRow : null;
    setMoreOpen(extra !== null);
    setExpanded(extra);
    if (!open) setSearch('');
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

  const effortChoices = useMemo(() => reasoningEffortChoices(variants, !!onVariantChange), [variants, onVariantChange]);
  const currentEffort = selectedVariant && effortChoices.includes(selectedVariant) ? selectedVariant : null;
  const currentModel = models.find((model) => sameModel(model, selectedModel));
  const modelShown = showModel && !!onModelChange;
  const modelOverridden = modelShown && modelIsOverridden(selectedModel, inheritedModel);
  const inheritedOffered = !!inheritedModel && models.some((model) => sameModel(model, inheritedModel));
  const modelName = currentModel?.modelName ?? selectedModel?.modelID ?? null;
  const resetModel = modelOverridden && inheritedOffered && inheritedModel && onModelChange ? () => onModelChange(inheritedModel) : undefined;
  const effortShown = effortChoices.length > 0 && !!onVariantChange;

  const extras = useMemo<ExtraRow[]>(
    () =>
      (overrides?.rows ?? []).map((row) => {
        const overridden = row.overridden === true;
        return {
          id: row.id,
          name: row.name,
          icon: row.icon,
          value: !overridden && row.inheritsFromAgent ? t('auto') : row.summary,
          overridden,
          onReset: overridden && overrides ? () => overrides.onResetRow(row.id) : undefined,
          description: row.description,
          editor: row.editor,
        };
      }),
    [overrides, t],
  );
  const extrasOverridden = extras.filter((row) => row.overridden).length;

  const parts = chatInputTriggerParts({
    model: modelShown ? modelName : null,
    effort: currentEffort ? effortLabel(currentEffort) : null,
    extras: extrasOverridden,
  });
  // The count reads as a bare number on the trigger; its accessible name spells it out.
  const spokenParts = parts.map((part, i) =>
    i === parts.length - 1 && extrasOverridden > 0 ? t('chatInputOverrideCount', { count: extrasOverridden }) : part,
  );

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
    const target = event.target as HTMLElement;
    const inPills = target.closest('[data-chat-input-pills]') !== null;
    // Left and right walk the pill row; up and down walk the whole panel.
    const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End', ...(inPills ? ['ArrowLeft', 'ArrowRight'] : [])];
    if (!keys.includes(event.key)) return;
    // Only the panel's own rows, the pills and the agent search walk. An
    // editor inside an expanded row (a select, a checkbox list) keeps its own arrow keys.
    const searchField = target.dataset.chatInputSearch !== undefined;
    if (!isNavItem(target) && !searchField) return;
    if (searchField && (event.key === 'Home' || event.key === 'End')) return;
    const items = Array.from(panelRef.current?.querySelectorAll<HTMLElement>(NAV_SELECTOR) ?? []).filter(
      (item) => !item.hasAttribute('disabled'),
    );
    if (items.length === 0) return;
    event.preventDefault();
    const index = items.indexOf(target);
    const forward = event.key === 'ArrowDown' || event.key === 'ArrowRight';
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : forward
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

  const expandedRow = extras.find((row) => row.id === expanded);
  const showSave = moreOpen && !!overrides && !!expandedRow && overrides.saveRowIds.includes(expandedRow.id);
  const saveAndClose = async () => {
    if (!overrides) return;
    const saved = await overrides.onSave();
    if (saved) setOpen(false);
  };
  const resetLabel = t('chatInputResetToAuto');
  const showAgents = !agentFixed;
  const showPills = modelShown || effortShown;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={[`${t('chatInput')}: ${agentLabel}`, ...spokenParts].join(' · ')}
          className="text-muted-foreground data-[state=open]:text-foreground min-w-0 rounded-lg hit-area-y-3"
        >
          <AgentMark slug={displayedName ?? agentLabel} />
          <span className={cn('max-w-[7rem] truncate', triggerLabelClassName)}>{agentLabel}</span>
          {parts.map((part, i) => (
            <span key={i} className="contents">
              <span aria-hidden>·</span>
              <span className={cn('min-w-0 truncate', i === 0 && modelShown ? 'max-w-[10rem]' : 'shrink-0')}>{part}</span>
            </span>
          ))}
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
        className="w-[min(320px,calc(100vw-1.5rem))] overflow-hidden p-0"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          const panel = panelRef.current;
          const target =
            panel?.querySelector<HTMLElement>('[data-chat-input-search]') ??
            panel?.querySelector<HTMLElement>(`[${NAV_ATTR}][aria-checked="true"]`) ??
            panel?.querySelector<HTMLElement>(NAV_SELECTOR);
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
            {showAgents && primaryAgents.length >= SEARCH_MIN_AGENTS ? (
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
            {showAgents ? (
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
                      className={menuRow('sm', 'default', checked ? 'text-foreground' : undefined)}
                    >
                      <AgentMark slug={agent.name} />
                      <span className="min-w-0 flex-1 truncate text-left">{label(agent.name)}</span>
                      <span className={MENU_INDICATOR}>
                        {checked ? <CheckIcon className={MENU_INDICATOR_ICON} /> : null}
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
            ) : null}

            {showPills ? (
              <>
                {/* The settings band: one quiet strip under the agents, no hairline. A single
                    "Reset" at its end appears only while the model or effort is overridden. */}
                <div
                  data-chat-input-pills=""
                  className={cn('bg-muted/60 flex items-center gap-0.5 rounded-lg p-0.5', showAgents && 'mt-1')}
                >
                  {modelShown && onModelChange ? (
                    <span {...{ [PILL_ATTR]: '' }} className="flex min-w-0">
                      <ModelSelector
                        models={models}
                        modelsLoading={modelsLoading}
                        selectedModel={selectedModel}
                        onSelect={onModelChange}
                        providers={providers}
                        defaultControls={modelDefaultControls}
                        projectId={projectId}
                        offerProviderAccounts
                        triggerVariant="ghost"
                        triggerLabelClassName="max-w-40 text-foreground"
                        open={modelOpen}
                        onOpenChange={setModelOpen}
                      />
                    </span>
                  ) : null}
                  {effortShown ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label={t('chatInputEffort')}
                      aria-expanded={effortOpen}
                      {...{ [NAV_ATTR]: '' }}
                      onClick={() => setEffortOpen((current) => !current)}
                      className="gap-1.5 rounded-lg"
                    >
                      <EffortIcon value={currentEffort} className="text-muted-foreground size-4 shrink-0" />
                      <span>{currentEffort ? effortLabel(currentEffort) : t('auto')}</span>
                      <CaretDownIcon
                        className={cn('size-3 opacity-50 transition-transform duration-moderate ease-out', effortOpen && 'rotate-180')}
                      />
                    </Button>
                  ) : null}
                  {resetModel || (currentEffort && onVariantChange) ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={saving}
                      {...{ [NAV_ATTR]: '' }}
                      onClick={() => {
                        resetModel?.();
                        if (currentEffort && onVariantChange) onVariantChange(null);
                      }}
                      className="text-muted-foreground hover:text-foreground ml-auto rounded-lg text-xs"
                    >
                      {t('chatInputReset')}
                    </Button>
                  ) : null}
                </div>
                {effortOpen && effortShown && onVariantChange ? (
                  <div role="radiogroup" aria-label={t('thinkingEffort')} className="flex flex-col gap-px pb-1">
                    {[null, ...effortChoices].map((value) => {
                      const checked = value === currentEffort;
                      return (
                        <button
                          key={value ?? 'auto'}
                          type="button"
                          role="radio"
                          aria-checked={checked}
                          {...{ [NAV_ATTR]: '' }}
                          onClick={() => {
                            onVariantChange(value);
                            setEffortOpen(false);
                          }}
                          className={menuRow('sm', 'default', checked ? 'text-foreground' : undefined)}
                        >
                          <EffortIcon value={value} className="size-4 shrink-0" />
                          <span className="min-w-0 flex-1 truncate text-left">{value ? effortLabel(value) : t('auto')}</span>
                          <span className={MENU_INDICATOR}>
                            {checked ? <CheckIcon className={MENU_INDICATOR_ICON} /> : null}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                ) : null}
              </>
            ) : null}

            {extras.length > 0 ? (
              <>
                <button
                  type="button"
                  aria-expanded={moreOpen}
                  {...{ [NAV_ATTR]: '' }}
                  onClick={() => setMoreOpen((current) => !current)}
                  className={menuRow('sm', 'default', cn('text-muted-foreground w-full', (showAgents || showPills) && 'mt-0.5'))}
                >
                  <span className="min-w-0 flex-1 truncate text-left text-xs">
                    {t('chatInputMoreSettings')}
                    {extrasOverridden > 0 ? ` · ${extrasOverridden}` : ''}
                  </span>
                  <CaretRightIcon className={cn('size-3 shrink-0 transition-transform duration-moderate ease-out', moreOpen && 'rotate-90')} />
                </button>
                {moreOpen ? (
                  <ul className="flex flex-col gap-px">
                    {extras.map((row) => (
                      <ChatInputRow
                        key={row.id}
                        row={row}
                        expanded={row.id === expanded}
                        disabled={saving}
                        resetLabel={resetLabel}
                        onToggle={() => setExpanded((current) => (current === row.id ? null : row.id))}
                      />
                    ))}
                  </ul>
                ) : null}
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

/** The × beside an overridden pill: back to the agent's default in one click. */
function PillReset({ label, disabled, onReset }: { label: string; disabled: boolean; onReset: () => void }) {
  return (
    <Hint side="top" label={label}>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={label}
        disabled={disabled}
        {...{ [NAV_ATTR]: '' }}
        onClick={onReset}
        className="text-muted-foreground hover:text-foreground shrink-0"
      >
        <XIcon className="size-3" />
      </Button>
    </Hint>
  );
}

function ChatInputRow({
  row,
  expanded,
  disabled,
  resetLabel,
  onToggle,
}: {
  row: ExtraRow;
  expanded: boolean;
  disabled: boolean;
  resetLabel: string;
  onToggle: () => void;
}) {
  const RowIcon = row.icon;
  return (
    <li>
      <div className="flex items-center gap-0.5">
        <button
          type="button"
          aria-expanded={expanded}
          {...{ [NAV_ATTR]: '' }}
          onClick={onToggle}
          className={menuRow('sm', 'default', 'min-w-0 flex-1')}
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
        </button>
        {row.onReset ? <PillReset label={`${resetLabel}: ${row.name}`} disabled={disabled} onReset={row.onReset} /> : null}
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
