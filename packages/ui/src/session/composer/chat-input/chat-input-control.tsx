'use client';

import type { Agent, FlatModel, ProviderListResponse } from '@kortix/sdk/react';
import { isMyKortixAgentName } from '@kortix/shared';
import { CaretDownIcon, CheckIcon, CpuIcon, MagnifyingGlassIcon } from '@phosphor-icons/react';
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

import { useTranslations } from '../../../i18n';
import { AgentMark } from '../../../internal/components/agent-mark';
import { cn } from '../../../lib/utils';
import { Button } from '../../../primitives/button';
import {
  InputGroupSearch,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from '../../../primitives/input-group';
import Loading from '../../../primitives/loading';
import { Popover, PopoverContent, PopoverTrigger } from '../../../primitives/popover';
import { ModelSelector, type ModelDefaultControls } from '../../models/model-selector';
import type { SessionOverrideRow } from '../../overrides/session-overrides-control';
import {
  AgentSelector,
  resolveDisplayedAgentName,
  useComposerAgentChoices,
} from '../agent-selector';
import { EffortIcon, effortLabel, reasoningEffortChoices } from '../reasoning-effort-selector';
import { useChatInputOverrides } from './chat-input-overrides';
import {
  chatInputAgents,
  chatInputTriggerParts,
  modelIsOverridden,
  sameModel,
  type ChatInputModelKey,
} from './chat-input-summary';

/** Same threshold as `AgentSelector`: past six agents scanning turns into scrolling. */
const SEARCH_MIN_AGENTS = 7;

/** The effort list's value for "no override: the agent's default". */
const AUTO_EFFORT = 'auto';

/**
 * How long the pointer rests on a row before the right pane follows it. A
 * diagonal move from a row to the pane crosses other rows; without the rest
 * each of them would swap the pane under the cursor.
 */
const HOVER_REST_MS = 90;

/** Between the panel's bottom edge and the composer card's top edge, in px. */
const PANEL_GAP = 6;

/** A radio row in the right pane (agents, efforts): the arrow keys walk them. */
const OPTION_ATTR = 'data-chat-input-option';

export type ChatInputRowId = 'agent' | 'model' | 'effort' | (string & {});

export interface ChatInputControlProps {
  /** Already filtered to the composer's primary agents. */
  agents: Agent[];
  selectedAgent: string | null;
  onAgentChange?: (agentName: string | null) => void;
  /** The agent is fixed (a DM): the panel names `selectedAgent`, offers no agent row, and keeps only the settings. */
  agentLocked?: boolean;
  /** Why there is nothing to pick. See `AgentSelector.unavailableHint`. */
  unavailableHint?: string | null;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** The row that opens highlighted, with focus in its pane: the `/` palette's "Switch model" and "Set reasoning effort". */
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

/** One row of the left list, and what the right pane shows for it. */
interface PaneItem {
  id: ChatInputRowId;
  name: string;
  icon: ReactNode;
  value: string;
  /** The value is a choice rather than a default: it reads in foreground. */
  strong: boolean;
  description?: string;
  onReset?: () => void;
  /** Secrets, provider keys, sandbox, files: the quiet group under a hairline. */
  extra: boolean;
}

/**
 * The composer card this control belongs to, found from its trigger: the
 * nearest bordered ancestor of the composer's editor. The trigger sits under
 * the card (`ComposerUnderbar` row) or inside it (the inline toolbar), so the
 * walk goes up from the trigger until a subtree holds the editor.
 */
function findComposerCard(from: HTMLElement | null): HTMLElement | null {
  let scope: HTMLElement | null = from;
  let editor: HTMLElement | null = null;
  while (scope && !editor) {
    editor = scope.querySelector<HTMLElement>('.ProseMirror');
    scope = scope.parentElement;
  }
  for (let node = editor?.parentElement ?? null; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (parseFloat(style.borderBottomWidth) > 0 && parseFloat(style.borderBottomLeftRadius) > 0)
      return node;
  }
  return null;
}

function isTextField(element: HTMLElement): boolean {
  return element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' || element.isContentEditable;
}

/**
 * The `chat_input` flag's composer control: the agent, its model and its
 * effort behind one trigger, and every other session override one step away.
 *
 * Closed, it names the agent and the model ("My Kortix · GLM 5.3 Flash"),
 * plus the effort when it is overridden and a count of the other overrides
 * (`chatInputTriggerParts`).
 *
 * Open, it is one panel that grows out of the top of the composer card: the
 * card's width, the card's surface and corners. Two panes, the shape of the
 * session-overrides gear it replaces:
 *
 *   - left, the settings: Agent (none when the agent is fixed: a DM), Model,
 *     Effort, then under one hairline the quiet ones (secrets, provider keys,
 *     sandbox, files). Each names its current value; a value someone chose
 *     reads in foreground, a default stays muted.
 *   - right, the highlighted setting: its name, one sentence, a Reset when
 *     it is overridden, and its editor. The agents and efforts are radio
 *     lists, the model is the model picker's own list in place.
 *
 * Hover (after a short rest) or the arrow keys move the highlight. Right,
 * Enter or Tab go into the pane; Left or Esc come back; Esc on the list
 * closes, and focus returns to the composer.
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
  const baseId = useId();

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

  // A fixed agent (a DM): name it and offer no other.
  const agentFixed = agentLocked;
  const agentChoice = chatInputAgents(
    primaryAgents.map((agent) => agent.name),
    agentFixed ? selectedAgent : (resolveDisplayedAgentName(primaryAgents, selectedAgent) ?? null),
    agentFixed,
    isMyKortixAgentName,
  );
  const displayedName = agentChoice.name ?? undefined;
  const agentLabel = displayedName ? label(displayedName) : t('chatInputAgent');

  const effortChoices = useMemo(
    () => reasoningEffortChoices(variants, !!onVariantChange),
    [variants, onVariantChange],
  );
  const currentEffort =
    selectedVariant && effortChoices.includes(selectedVariant) ? selectedVariant : null;
  const currentModel = models.find((model) => sameModel(model, selectedModel));
  const modelShown = showModel && !!onModelChange;
  const modelOverridden = modelShown && modelIsOverridden(selectedModel, inheritedModel);
  const inheritedOffered =
    !!inheritedModel && models.some((model) => sameModel(model, inheritedModel));
  const modelName = currentModel?.modelName ?? selectedModel?.modelID ?? null;
  const resetModel =
    modelOverridden && inheritedOffered && inheritedModel && onModelChange
      ? () => onModelChange(inheritedModel)
      : undefined;
  const effortShown = effortChoices.length > 0 && !!onVariantChange;
  const showAgents = !agentFixed;

  const extraRows = overrides?.rows;
  const extrasOverridden = (extraRows ?? []).filter((row) => row.overridden === true).length;

  const parts = chatInputTriggerParts({
    model: modelShown ? modelName : null,
    effort: currentEffort ? effortLabel(currentEffort) : null,
    extras: extrasOverridden,
  });
  // The count reads as a bare number on the trigger; its accessible name spells it out.
  const spokenParts = parts.map((part, i) =>
    i === parts.length - 1 && extrasOverridden > 0
      ? t('chatInputOverrideCount', { count: extrasOverridden })
      : part,
  );

  const items: PaneItem[] = [];
  if (showAgents) {
    items.push({
      id: 'agent',
      name: t('chatInputAgent'),
      icon: <AgentMark slug={displayedName ?? agentLabel} />,
      value: agentLabel,
      strong: true,
      description: t('chatInputAgentDescription'),
      extra: false,
    });
  }
  if (modelShown) {
    items.push({
      id: 'model',
      name: t('chatInputModel'),
      icon: <CpuIcon className="size-4" />,
      value: modelName ?? t('noModel'),
      strong: modelOverridden,
      description: t('chatInputModelDescription'),
      onReset: resetModel,
      extra: false,
    });
  }
  if (effortShown && onVariantChange) {
    items.push({
      id: 'effort',
      name: t('chatInputEffort'),
      icon: <EffortIcon value={currentEffort} className="size-4" />,
      value: currentEffort ? effortLabel(currentEffort) : t('auto'),
      strong: !!currentEffort,
      description: t('chatInputEffortDescription'),
      onReset: currentEffort ? () => onVariantChange(null) : undefined,
      extra: false,
    });
  }
  for (const row of extraRows ?? []) {
    const overridden = row.overridden === true;
    const RowIcon: SessionOverrideRow['icon'] = row.icon;
    items.push({
      id: row.id,
      name: row.name,
      icon: <RowIcon className="size-4" />,
      value: !overridden && row.inheritsFromAgent ? t('auto') : row.summary,
      strong: overridden,
      description: row.description,
      onReset: overridden && overrides ? () => overrides.onResetRow(row.id) : undefined,
      extra: true,
    });
  }

  // The highlighted row. Each open starts on the row the `/` palette asked
  // for, else the first. Adjusted during render (React's "storing information
  // from previous renders"), not in an effect, so the first open frame
  // already shows it.
  const [activeId, setActiveId] = useState<ChatInputRowId | null>(null);
  const [search, setSearch] = useState('');
  const [seen, setSeen] = useState({ open, initialRow });
  if (seen.open !== open || seen.initialRow !== initialRow) {
    setSeen({ open, initialRow });
    if (open) setActiveId(initialRow);
    else setSearch('');
  }
  const active = items.find((item) => item.id === activeId) ?? items[0];

  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (hoverTimer.current) clearTimeout(hoverTimer.current);
    },
    [],
  );

  /*
    The panel opens from the composer card, not from the trigger: it takes the
    card's width and its bottom edge sits just above the card's top (or the top
    of the strip stacked on it: the queue, a notice). Radix still anchors to
    the trigger; the offsets below move the panel from the trigger to the card.
    Measured on open and on resize. A composer without a card (none found)
    keeps the trigger's position and a fixed width.
  */
  const [placement, setPlacement] = useState<{
    sideOffset: number;
    alignOffset: number;
    width: number;
  } | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    let frame = 0;
    let tries = 0;
    let observer: ResizeObserver | null = null;
    const measure = () => {
      const trigger = triggerRef.current;
      const card = findComposerCard(trigger);
      if (!trigger || !card) {
        // The editor can mount a frame after the panel opens (a cold
        // composer). Look again for a few frames before keeping the fallback.
        if (tries++ < 20) frame = requestAnimationFrame(measure);
        return;
      }
      if (!observer && typeof ResizeObserver !== 'undefined') {
        observer = new ResizeObserver(() => measure());
        observer.observe(card);
      }
      const triggerBox = trigger.getBoundingClientRect();
      const box = card.getBoundingClientRect();
      const stack = card.previousElementSibling;
      const top =
        stack instanceof HTMLElement && stack.hasAttribute('data-composer-stack')
          ? Math.min(stack.getBoundingClientRect().top, box.top)
          : box.top;
      const next = {
        sideOffset: Math.round(triggerBox.top - top) + PANEL_GAP,
        alignOffset: Math.round(box.left - triggerBox.left),
        width: Math.round(box.width),
      };
      setPlacement((current) =>
        current &&
        current.sideOffset === next.sideOffset &&
        current.alignOffset === next.alignOffset &&
        current.width === next.width
          ? current
          : next,
      );
    };
    measure();
    window.addEventListener('resize', measure);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener('resize', measure);
      setPlacement(null);
    };
  }, [open]);

  const focusTab = (id: ChatInputRowId | undefined) => {
    if (!id) return;
    listRef.current?.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(id)}"]`)?.focus();
  };

  /** Into the right pane: its checked option, else its first control. */
  const focusPane = () => {
    const pane = paneRef.current;
    if (!pane) return;
    const target =
      pane.querySelector<HTMLElement>(`[${OPTION_ATTR}][aria-checked="true"]`) ??
      pane.querySelector<HTMLElement>('input:not([disabled]), [cmdk-input]') ??
      pane.querySelector<HTMLElement>(
        `[${OPTION_ATTR}], button:not([disabled]), [href], select, textarea, [tabindex]:not([tabindex="-1"])`,
      );
    target?.focus();
  };

  const select = (id: ChatInputRowId) => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    setActiveId(id);
  };

  const onPanelKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const rowId = target.dataset.rowId;
    if (rowId !== undefined) {
      // The left list: up and down walk the rows, right and Enter go into the pane.
      const ids = items.map((item) => item.id);
      const index = ids.indexOf(rowId);
      let next: number | null = null;
      if (event.key === 'ArrowDown') next = (index + 1) % ids.length;
      else if (event.key === 'ArrowUp') next = (index <= 0 ? ids.length : index) - 1;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = ids.length - 1;
      if (next !== null) {
        event.preventDefault();
        select(ids[next]!);
        focusTab(ids[next]);
        return;
      }
      if (event.key === 'ArrowRight' || event.key === 'Enter') {
        event.preventDefault();
        select(rowId);
        // The pane renders the row's editor on this commit; focus it on the next frame.
        requestAnimationFrame(focusPane);
      }
      return;
    }
    if (!paneRef.current?.contains(target)) return;
    // Left leaves the pane, except where it moves a caret through typed text.
    if (
      event.key === 'ArrowLeft' &&
      (!isTextField(target) || (target as HTMLInputElement).value === '')
    ) {
      event.preventDefault();
      focusTab(active?.id);
      return;
    }
    // The agent search hands Down to the first agent.
    if (event.key === 'ArrowDown' && target.dataset.chatInputSearch !== undefined) {
      event.preventDefault();
      paneRef.current.querySelector<HTMLElement>(`[${OPTION_ATTR}]`)?.focus();
      return;
    }
    // A radio list (agents, efforts): up and down walk its options.
    if (
      target.hasAttribute(OPTION_ATTR) &&
      ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)
    ) {
      const options = Array.from(
        target
          .closest('[role="radiogroup"]')
          ?.querySelectorAll<HTMLElement>(`[${OPTION_ATTR}]:not([disabled])`) ?? [],
      );
      const index = options.indexOf(target);
      const next =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? options.length - 1
            : event.key === 'ArrowDown'
              ? Math.min(index + 1, options.length - 1)
              : index - 1;
      event.preventDefault();
      if (next < 0) {
        paneRef.current.querySelector<HTMLElement>('[data-chat-input-search]')?.focus();
        return;
      }
      options[next]?.focus();
    }
  };

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

  const activeExtra = active?.extra ? extraRows?.find((row) => row.id === active.id) : undefined;
  const showSave = !!overrides && !!activeExtra && overrides.saveRowIds.includes(activeExtra.id);
  const saveAndClose = async () => {
    if (!overrides) return;
    const saved = await overrides.onSave();
    if (saved) setOpen(false);
  };

  let editor: ReactNode = null;
  if (active?.id === 'agent') {
    editor = (
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-1.5">
        {primaryAgents.length >= SEARCH_MIN_AGENTS ? (
          <InputGroupSearch className="px-0.5 pb-1">
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
        <div role="radiogroup" aria-label={t('chatInputAgent')} className="flex flex-col gap-px">
          {filteredAgents.map((agent) => {
            const checked = agent.name === displayedName;
            const description = isMyKortixAgentName(agent.name)
              ? t('myKortixRoutes')
              : agent.description;
            return (
              <OptionRow
                key={agent.name}
                checked={checked}
                onSelect={() => onAgentChange?.(agent.name)}
                icon={<AgentMark slug={agent.name} size={21} tile={28} />}
                label={label(agent.name)}
                description={description}
              />
            );
          })}
          {filteredAgents.length === 0 ? (
            <p className="text-muted-foreground px-2 py-3 text-xs">
              {tHardcodedUi.raw(
                'componentsSessionSessionChatInput.line273JsxTextNoAgentsMatchLdquo',
              )}
              {search.trim()}
              {tHardcodedUi.raw('componentsSessionSessionChatInput.line273JsxTextRdquo')}
            </p>
          ) : null}
        </div>
      </div>
    );
  } else if (active?.id === 'model' && onModelChange) {
    editor = (
      <div className="border-border flex min-h-0 flex-1 flex-col border-t">
        <ModelSelector
          appearance="inline"
          models={models}
          modelsLoading={modelsLoading}
          selectedModel={selectedModel}
          onSelect={onModelChange}
          providers={providers}
          defaultControls={modelDefaultControls}
          projectId={projectId}
          offerProviderAccounts
        />
      </div>
    );
  } else if (active?.id === 'effort' && onVariantChange) {
    editor = (
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-1.5">
        <div role="radiogroup" aria-label={t('chatInputEffort')} className="flex flex-col gap-px">
          {[AUTO_EFFORT, ...effortChoices].map((value) => {
            const checked = (currentEffort ?? AUTO_EFFORT) === value;
            return (
              <OptionRow
                key={value}
                checked={checked}
                disabled={saving}
                onSelect={() => onVariantChange(value === AUTO_EFFORT ? null : value)}
                icon={<EffortIcon value={value} className="text-muted-foreground size-4" />}
                label={value === AUTO_EFFORT ? t('auto') : effortLabel(value)}
              />
            );
          })}
        </div>
      </div>
    );
  } else if (activeExtra) {
    editor = (
      <div className="min-h-0 flex-1 overflow-y-auto px-3.5 pb-3">
        {activeExtra.editor}
        {overrides?.notice && showSave ? <div className="mt-3">{overrides.notice}</div> : null}
      </div>
    );
  }

  const tabId = (id: string) => `${baseId}-tab-${id}`;
  const paneId = `${baseId}-pane`;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          ref={triggerRef}
          type="button"
          variant="ghost"
          size="sm"
          aria-label={[`${t('chatInput')}: ${agentLabel}`, ...spokenParts].join(' · ')}
          className="text-muted-foreground data-[state=open]:text-foreground hit-area-y-3 min-w-0 rounded-lg"
        >
          <AgentMark slug={displayedName ?? agentLabel} />
          <span className={cn('max-w-[7rem] truncate', triggerLabelClassName)}>{agentLabel}</span>
          {parts.map((part, i) => (
            <span key={i} className="contents">
              <span aria-hidden>·</span>
              <span
                className={cn(
                  'min-w-0 truncate',
                  i === 0 && modelShown ? 'max-w-[10rem]' : 'shrink-0',
                )}
              >
                {part}
              </span>
            </span>
          ))}
          <CaretDownIcon
            className={cn(
              'duration-moderate size-3 shrink-0 transition-transform ease-out',
              open && 'rotate-180',
            )}
          />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        aria-label={t('chatInput')}
        side="top"
        align="start"
        sideOffset={placement?.sideOffset ?? PANEL_GAP}
        alignOffset={placement?.alignOffset ?? 0}
        collisionPadding={12}
        style={placement ? { width: placement.width } : undefined}
        // The card's own surface and corners, at the card's width: the panel
        // reads as the composer grown upward, not as a menu beside it.
        className={cn(
          'bg-background @container overflow-hidden rounded-xl p-0',
          'max-w-[calc(100vw-1.5rem)]',
          !placement && 'w-[min(36rem,calc(100vw-1.5rem))]',
        )}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          if (initialRow) requestAnimationFrame(focusPane);
          else focusTab(active?.id);
        }}
        onCloseAutoFocus={(event) => {
          // Back to the message: the panel was a detour on the way to Send.
          const editorNode = findComposerCard(triggerRef.current)?.querySelector<HTMLElement>(
            '.ProseMirror',
          );
          if (!editorNode) return;
          event.preventDefault();
          editorNode.focus();
        }}
        onEscapeKeyDown={(event) => {
          if (saving) {
            event.preventDefault();
            return;
          }
          // Esc in the pane steps back to the list; Esc on the list closes.
          if (paneRef.current?.contains(document.activeElement)) {
            event.preventDefault();
            focusTab(active?.id);
          }
        }}
        // The editors' selects and the provider modals open in their own portals.
        // Radix counts those as outside, and would close this panel under the cursor.
        onInteractOutside={(event) => {
          const target = event.target as HTMLElement | null;
          if (saving || target?.closest('[data-radix-popper-content-wrapper]'))
            event.preventDefault();
        }}
      >
        <div
          onKeyDown={onPanelKeyDown}
          // A fixed height: the panel opens upward from the card, so a pane
          // that changed height with the highlighted row would move its top
          // edge under the cursor. Radix reports the room it has; without the
          // cap the panel outgrows the gap above the composer on a 480px-tall window.
          className="flex h-[min(22rem,var(--radix-popover-content-available-height,22rem))] flex-col"
        >
          <div className="flex min-h-0 flex-1">
            <div
              ref={listRef}
              role="tablist"
              aria-orientation="vertical"
              aria-label={t('chatInput')}
              className="border-border flex w-2/5 max-w-72 shrink-0 flex-col gap-px overflow-y-auto border-r p-1.5"
            >
              {items.map((item, index) => {
                const selected = item.id === active?.id;
                const firstExtra = item.extra && !items[index - 1]?.extra && index > 0;
                return (
                  <div key={item.id} className="contents">
                    {firstExtra ? (
                      <div role="separator" className="bg-border mx-2 my-1 h-px shrink-0" />
                    ) : null}
                    <button
                      type="button"
                      role="tab"
                      id={tabId(item.id)}
                      aria-selected={selected}
                      aria-controls={paneId}
                      tabIndex={selected ? 0 : -1}
                      data-row-id={item.id}
                      onClick={() => select(item.id)}
                      onPointerEnter={() => {
                        if (hoverTimer.current) clearTimeout(hoverTimer.current);
                        hoverTimer.current = setTimeout(() => setActiveId(item.id), HOVER_REST_MS);
                      }}
                      onPointerLeave={() => {
                        if (hoverTimer.current) clearTimeout(hoverTimer.current);
                      }}
                      className={cn(
                        'focus-visible:ring-ring flex h-8 w-full min-w-0 shrink-0 items-center gap-2 rounded-md px-2 text-left text-sm outline-none focus-visible:ring-2',
                        selected
                          ? 'bg-active text-foreground'
                          : 'hover:bg-hover hover:text-foreground',
                        !selected && (item.extra ? 'text-muted-foreground' : 'text-foreground'),
                      )}
                    >
                      <span
                        className={cn(
                          'flex size-4 shrink-0 items-center justify-center',
                          selected ? 'text-foreground' : 'text-muted-foreground',
                        )}
                      >
                        {item.icon}
                      </span>
                      <span className="shrink-0 truncate font-medium">{item.name}</span>
                      <span
                        className={cn(
                          'ml-auto hidden min-w-0 truncate pl-2 text-right text-xs @[30rem]:block',
                          item.strong ? 'text-foreground' : 'text-muted-foreground',
                        )}
                      >
                        {item.value}
                      </span>
                    </button>
                  </div>
                );
              })}
            </div>

            <div
              ref={paneRef}
              id={paneId}
              role="tabpanel"
              aria-labelledby={active ? tabId(active.id) : undefined}
              className="flex min-h-0 min-w-0 flex-1 flex-col"
            >
              {active ? (
                <div className="flex shrink-0 items-start gap-3 px-3.5 pt-3 pb-2.5">
                  <div className="min-w-0 flex-1">
                    <h3 className="text-foreground text-sm font-medium text-balance">
                      {active.name}
                    </h3>
                    {active.description ? (
                      <p className="text-muted-foreground mt-0.5 text-xs text-pretty">
                        {active.description}
                      </p>
                    ) : null}
                  </div>
                  {active.onReset ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      disabled={saving}
                      onClick={active.onReset}
                      className="text-muted-foreground hover:text-foreground -mt-0.5 -mr-1.5 shrink-0"
                    >
                      {t('chatInputReset')}
                    </Button>
                  ) : null}
                </div>
              ) : null}
              {editor}
            </div>
          </div>

          {overrides?.error ? (
            <p role="alert" className="text-destructive border-border border-t px-4 py-2 text-xs">
              {overrides.error}
            </p>
          ) : null}
          {showSave && overrides ? (
            <div className="border-border flex shrink-0 items-center justify-between gap-3 border-t px-4 py-2">
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

/** One radio row in the right pane: an agent or an effort. */
function OptionRow({
  checked,
  disabled = false,
  onSelect,
  icon,
  label,
  description,
}: {
  checked: boolean;
  disabled?: boolean;
  onSelect: () => void;
  icon: ReactNode;
  label: string;
  description?: string | null;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      disabled={disabled}
      tabIndex={checked ? 0 : -1}
      {...{ [OPTION_ATTR]: '' }}
      onClick={onSelect}
      className={cn(
        'focus-visible:ring-ring flex w-full min-w-0 items-center gap-2.5 rounded-md px-2 text-left outline-none focus-visible:ring-2 disabled:pointer-events-none disabled:opacity-50',
        description ? 'py-1.5' : 'h-8',
        checked ? 'bg-active' : 'hover:bg-hover',
      )}
    >
      {icon}
      <span className="min-w-0 flex-1">
        <span className="text-foreground block truncate text-sm font-medium">{label}</span>
        {description ? (
          <span className="text-muted-foreground block truncate text-xs">{description}</span>
        ) : null}
      </span>
      <span className="flex size-4 shrink-0 items-center justify-center">
        {checked ? <CheckIcon className="text-foreground size-3.5" /> : null}
      </span>
    </button>
  );
}
