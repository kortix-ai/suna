'use client';

import type { Agent, FlatModel, ProviderListResponse } from '@kortix/sdk/react';
import { isMyKortixAgentName } from '@kortix/shared';
import {
  CaretDownIcon,
  CaretRightIcon,
  CpuIcon,
  MagnifyingGlassIcon,
  PlugsConnectedIcon,
} from '@phosphor-icons/react';
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
  ChoiceRow,
  ConnectorsPane,
  OPTION_ATTR,
  ProviderKeysPane,
  SecretsPane,
  connectorsChanged,
  providerKeysInEffect,
  secretsInEffect,
} from './chat-input-panes';
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

/** The panel's width: room for the list and a pane, not the whole composer. */
const PANEL_WIDTH = 'w-[min(37rem,calc(100vw-1.5rem))]';

/** The left list's "More" row: it opens the extras and has no pane of its own. */
const MORE_ROW = '__more';

/** The extra rows, in the order the list shows them. */
const EXTRA_ORDER = ['connectors', 'secrets', 'provider-keys', 'sandbox'];

/** An open dialog that is not this panel: the Models dialog, an accounts modal. */
function foreignDialogOpen(panel: HTMLElement | null): boolean {
  for (const dialog of document.querySelectorAll<HTMLElement>(
    '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]',
  )) {
    if (!panel || (dialog !== panel && !panel.contains(dialog) && !dialog.contains(panel)))
      return true;
  }
  return false;
}

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
  /** What the prompt carries: the agent's default, or the override. */
  value: string;
  /** Someone chose this value: a dot marks it. */
  overridden: boolean;
  description?: string;
  onReset?: () => void;
  /** Connectors, secrets, provider keys, machine: the group under a gap. */
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
      overridden: false,
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
      overridden: modelOverridden,
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
      overridden: !!currentEffort,
      description: t('chatInputEffortDescription'),
      onReset: currentEffort ? () => onVariantChange(null) : undefined,
      extra: false,
    });
  }
  const scopeData = overrides?.scope;
  const keyData = overrides?.providerKeys;
  const agentDefault = t('chatInputAgentDefault');
  const sortedExtras = [...(extraRows ?? [])].sort(
    (left, right) => EXTRA_ORDER.indexOf(left.id) - EXTRA_ORDER.indexOf(right.id),
  );
  for (const row of sortedExtras) {
    const overridden = row.overridden === true;
    const RowIcon: SessionOverrideRow['icon'] = row.icon;
    const item: PaneItem = {
      id: row.id,
      name: row.name,
      icon: <RowIcon className="size-4" />,
      value: overridden ? row.summary : agentDefault,
      overridden,
      description: row.description,
      onReset: overridden && overrides ? () => overrides.onResetRow(row.id) : undefined,
      extra: true,
    };
    // Each row says what the prompt will carry, in the same words.
    if (row.id === 'connectors') {
      const changed = scopeData ? connectorsChanged(scopeData) : null;
      item.name = t('chatInputConnectors');
      item.icon = <PlugsConnectedIcon className="size-4" />;
      item.value = changed === null ? agentDefault : t('chatInputAppCount', { count: changed });
      item.description = t('chatInputConnectorsDescription');
    } else if (row.id === 'secrets') {
      // No secret to send or to hold back: nothing to change here.
      if (
        !overridden &&
        scopeData?.catalog.secrets.status === 'ready' &&
        scopeData.catalog.secrets.items.length === 0
      )
        continue;
      const count = scopeData ? secretsInEffect(scopeData) : null;
      item.name = t('chatInputSecrets');
      item.value = !overridden
        ? count === null || count === 0
          ? agentDefault
          : `${agentDefault} · ${count}`
        : t('chatInputSecretCount', { count: count ?? 0 });
      item.description = t('chatInputSecretsDescription');
    } else if (row.id === 'provider-keys') {
      const count = keyData ? providerKeysInEffect(keyData) : 0;
      item.overridden = count > 0;
      item.value = count > 0 ? t('chatInputKeyCount', { count }) : agentDefault;
      item.description = t('chatInputProviderKeysDescription');
    } else if (row.id === 'sandbox') {
      item.name = t('chatInputMachine');
      item.description = t('chatInputMachineDescription');
    }
    items.push(item);
  }

  // The highlighted row. Each open starts on the row the `/` palette asked
  // for, else the first. Adjusted during render (React's "storing information
  // from previous renders"), not in an effect, so the first open frame
  // already shows it.
  const [activeId, setActiveId] = useState<ChatInputRowId | null>(null);
  const [search, setSearch] = useState('');
  // The extras (connectors, secrets, provider keys, machine) sit behind one
  // "More" row; each open starts with it closed, unless the `/` palette asked
  // for one of them.
  const [moreOpen, setMoreOpen] = useState(false);
  const [seen, setSeen] = useState({ open, initialRow });
  if (seen.open !== open || seen.initialRow !== initialRow) {
    setSeen({ open, initialRow });
    if (open) {
      setActiveId(initialRow);
      setMoreOpen(items.some((item) => item.extra && item.id === initialRow));
    } else setSearch('');
  }
  const mainItems = items.filter((item) => !item.extra);
  const extraItems = items.filter((item) => item.extra);
  const extrasChanged = extraItems.filter((item) => item.overridden).length;
  // What the left list shows, in order; `MORE_ROW` is the disclosure itself.
  const listIds = [
    ...mainItems.map((item) => item.id),
    ...(extraItems.length > 0 ? [MORE_ROW] : []),
    ...(moreOpen ? extraItems.map((item) => item.id) : []),
  ];
  const visible = items.filter((item) => listIds.includes(item.id));
  const active = visible.find((item) => item.id === activeId) ?? visible[0];

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
    The panel opens from the composer card, not from the trigger: its left
    edge is the card's left edge and its bottom edge sits just above the
    card's top (or the top of the strip stacked on it: the queue, a notice).
    Radix still anchors to the trigger; the offsets below move the panel from
    the trigger to the card. Measured on open and on resize. A composer
    without a card (none found) keeps the trigger's position.
  */
  const [placement, setPlacement] = useState<{
    sideOffset: number;
    alignOffset: number;
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
      };
      setPlacement((current) =>
        current &&
        current.sideOffset === next.sideOffset &&
        current.alignOffset === next.alignOffset
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

  /*
    A dialog opened from inside the panel (the Models dialog behind "+", a
    ChatGPT accounts modal, a model-connection gate) must sit above it. The
    panel stays mounted, so a dialog it owns keeps its state, but it hides
    and ignores outside clicks until no other dialog is open. When the dialog
    closes the panel shows again where it was.
  */
  const contentRef = useRef<HTMLDivElement>(null);
  const [suspended, setSuspended] = useState(false);
  useEffect(() => {
    if (!open) return;
    const check = () => setSuspended(foreignDialogOpen(contentRef.current));
    check();
    const observer = new MutationObserver(check);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-state'],
    });
    return () => {
      observer.disconnect();
      setSuspended(false);
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

  /** Opening "More" highlights its first row; closing it while one is highlighted goes back to the first row. */
  const toggleMore = (next = !moreOpen) => {
    setMoreOpen(next);
    if (next && extraItems[0]) {
      select(extraItems[0].id);
      requestAnimationFrame(() => focusTab(extraItems[0]!.id));
    } else if (!next && active?.extra) {
      select(mainItems[0]?.id ?? MORE_ROW);
      requestAnimationFrame(() => focusTab(MORE_ROW));
    }
  };

  const onPanelKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const rowId = target.dataset.rowId;
    if (rowId !== undefined) {
      // The left list: up and down walk the rows, right and Enter go into the pane.
      const ids = listIds;
      const index = ids.indexOf(rowId);
      let next: number | null = null;
      if (event.key === 'ArrowDown') next = (index + 1) % ids.length;
      else if (event.key === 'ArrowUp') next = (index <= 0 ? ids.length : index) - 1;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = ids.length - 1;
      if (next !== null) {
        event.preventDefault();
        // "More" takes focus but keeps the pane on the row before it.
        if (ids[next] !== MORE_ROW) select(ids[next]!);
        focusTab(ids[next]);
        return;
      }
      if (rowId === MORE_ROW) {
        if (event.key === 'ArrowRight' || event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          toggleMore(true);
        } else if (event.key === 'ArrowLeft' && moreOpen) {
          event.preventDefault();
          toggleMore(false);
        }
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
  // The Save footer shows only while there is something to save, whichever row is highlighted.
  const showSave = !!overrides && overrides.dirty;
  const saveAndClose = async () => {
    if (!overrides) return;
    const saved = await overrides.onSave();
    if (saved) setOpen(false);
  };

  let editor: ReactNode = null;
  if (active?.id === 'agent') {
    editor = (
      <>
        {primaryAgents.length >= SEARCH_MIN_AGENTS ? (
          <InputGroupSearch className="pb-1">
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
          {filteredAgents.map((agent) => (
            <ChoiceRow
              key={agent.name}
              checked={agent.name === displayedName}
              onSelect={() => onAgentChange?.(agent.name)}
              icon={<AgentMark slug={agent.name} size={21} tile={28} />}
              label={label(agent.name)}
              description={
                isMyKortixAgentName(agent.name) ? t('myKortixRoutes') : agent.description
              }
            />
          ))}
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
      </>
    );
  } else if (active?.id === 'effort' && onVariantChange) {
    editor = (
      <div role="radiogroup" aria-label={t('chatInputEffort')} className="flex flex-col gap-px">
        {[AUTO_EFFORT, ...effortChoices].map((value) => (
          <ChoiceRow
            key={value}
            checked={(currentEffort ?? AUTO_EFFORT) === value}
            disabled={saving}
            onSelect={() => onVariantChange(value === AUTO_EFFORT ? null : value)}
            icon={<EffortIcon value={value} className="text-foreground size-4" />}
            label={value === AUTO_EFFORT ? t('auto') : effortLabel(value)}
          />
        ))}
      </div>
    );
  } else if (active?.id === 'secrets' && scopeData) {
    editor = <SecretsPane scope={scopeData} />;
  } else if (active?.id === 'connectors' && scopeData) {
    editor = <ConnectorsPane scope={scopeData} />;
  } else if (active?.id === 'provider-keys' && keyData) {
    editor = <ProviderKeysPane providerKeys={keyData} />;
  } else if (activeExtra) {
    editor = <div className="px-2">{activeExtra.editor}</div>;
  }
  const notice =
    overrides?.notice && activeExtra && overrides.saveRowIds.includes(activeExtra.id) ? (
      <div className="px-2 pt-2">{overrides.notice}</div>
    ) : null;

  const tabId = (id: string) => `${baseId}-tab-${id}`;
  const paneId = `${baseId}-pane`;
  const modelPane = active?.id === 'model' && !!onModelChange;

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
        ref={contentRef}
        // While a dialog sits above, the hidden panel must not count as an open
        // floating layer: `Modal` refuses Escape and backdrop clicks while one is
        // open (`hasOpenFloatingLayer`), which left the dialog impossible to close.
        {...(suspended ? { 'data-state': 'suspended' } : {})}
        aria-label={t('chatInput')}
        side="top"
        align="start"
        sideOffset={placement?.sideOffset ?? PANEL_GAP}
        alignOffset={placement?.alignOffset ?? 0}
        collisionPadding={12}
        // The composer card's surface and corners: the panel reads as the
        // composer grown upward, not as a menu beside it.
        className={cn(
          'bg-background overflow-hidden rounded-xl p-0',
          PANEL_WIDTH,
          // A dialog opened from inside sits above: the panel steps out of its way.
          suspended && 'invisible',
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
        // The editors' selects open in their own portals, and a dialog opened
        // from inside is outside too. Radix would close this panel under the cursor.
        onInteractOutside={(event) => {
          const target = event.target as HTMLElement | null;
          if (
            saving ||
            foreignDialogOpen(contentRef.current) ||
            target?.closest('[data-radix-popper-content-wrapper], [role="dialog"]')
          )
            event.preventDefault();
        }}
        onFocusOutside={(event) => {
          if (foreignDialogOpen(contentRef.current)) event.preventDefault();
        }}
      >
        <div
          onKeyDown={onPanelKeyDown}
          // As tall as the list on the left, never taller than the room
          // above the composer; the pane on the right scrolls inside that.
          className="flex max-h-[var(--radix-popover-content-available-height,32rem)] flex-col"
        >
          <div className="flex min-h-[9.5rem] flex-1">
            <div
              ref={listRef}
              role="tablist"
              aria-orientation="vertical"
              aria-label={t('chatInput')}
              className="flex w-72 shrink-0 flex-col gap-px overflow-y-auto p-1.5"
            >
              {listIds.map((id) => {
                if (id === MORE_ROW) {
                  return (
                    <button
                      key={MORE_ROW}
                      type="button"
                      aria-expanded={moreOpen}
                      tabIndex={-1}
                      data-row-id={MORE_ROW}
                      onClick={() => toggleMore()}
                      className="focus-visible:ring-ring hover:bg-hover text-foreground flex min-h-7 w-full min-w-0 shrink-0 items-center gap-2 rounded-md px-2 py-1 text-left text-sm outline-none focus-visible:ring-2"
                    >
                      <span className="flex size-4 shrink-0 items-center justify-center">
                        <CaretRightIcon
                          className={cn(
                            'duration-moderate size-3.5 transition-transform ease-out motion-reduce:transition-none',
                            moreOpen && 'rotate-90',
                          )}
                        />
                      </span>
                      <span className="shrink-0 truncate font-medium">{t('chatInputMore')}</span>
                      {extrasChanged > 0 ? (
                        <span className="ml-auto flex items-center gap-1.5 pl-2 text-xs tabular-nums">
                          <span
                            aria-hidden
                            className="bg-foreground size-1 shrink-0 rounded-full"
                          />
                          {t('chatInputChangedCount', { count: extrasChanged })}
                        </span>
                      ) : null}
                    </button>
                  );
                }
                const item = items.find((candidate) => candidate.id === id)!;
                const selected = item.id === active?.id;
                return (
                  <button
                    key={item.id}
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
                      'focus-visible:ring-ring text-foreground flex min-h-7 w-full min-w-0 shrink-0 items-center gap-2 rounded-md py-1 pr-2 text-left text-sm outline-none focus-visible:ring-2',
                      // Rows under "More" step in by one icon, so they read as its children.
                      item.extra ? 'pl-6' : 'pl-2',
                      selected ? 'bg-active' : 'hover:bg-hover',
                    )}
                  >
                    <span className="flex size-4 shrink-0 items-center justify-center">
                      {item.icon}
                    </span>
                    <span className="shrink-0 truncate font-medium">{item.name}</span>
                    <span className="ml-auto flex min-w-0 items-center gap-1.5 pl-2">
                      {item.overridden ? (
                        <span aria-hidden className="bg-foreground size-1 shrink-0 rounded-full" />
                      ) : null}
                      <span className="min-w-0 truncate text-right text-xs">{item.value}</span>
                    </span>
                  </button>
                );
              })}
            </div>

            <div
              ref={paneRef}
              id={paneId}
              role="tabpanel"
              aria-labelledby={active ? tabId(active.id) : undefined}
              // Out of flow: the list alone sets the panel's height.
              className="relative min-w-0 flex-1"
            >
              <div className="absolute inset-0 flex flex-col">
                {active ? (
                  <div className="flex shrink-0 items-start gap-3 px-3.5 pt-2.5 pb-1.5">
                    <div className="min-w-0 flex-1">
                      <h3 className="text-foreground text-sm font-medium">{active.name}</h3>
                      {active.description ? (
                        <p className="text-muted-foreground text-xs text-pretty">
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
                        className="-mt-0.5 -mr-1.5 shrink-0"
                      >
                        {t('chatInputReset')}
                      </Button>
                    ) : null}
                  </div>
                ) : null}
                {modelPane ? (
                  <div className="flex min-h-0 flex-1 flex-col">
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
                ) : (
                  <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-1.5">
                    {editor}
                    {notice}
                  </div>
                )}
              </div>
            </div>
          </div>

          {overrides?.error ? (
            <p role="alert" className="text-destructive px-3.5 py-2 text-xs">
              {overrides.error}
            </p>
          ) : null}
          {showSave && overrides ? (
            <div className="bg-muted flex shrink-0 items-center justify-between gap-3 px-3.5 py-1.5">
              <p className="text-foreground text-xs text-pretty" aria-live="polite">
                {overrides.pendingNote ?? tHardcodedUi.raw('i18nComplete.text26ee1166df63')}
              </p>
              <Button
                type="button"
                size="xs"
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
