'use client';

import { Button } from '@/components/ui/button';
import {
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandPopover,
  CommandPopoverContent,
  CommandPopoverTrigger,
  CommandSeparator,
} from '@/components/ui/command';
import Loading from '@/components/ui/loading';
import { ChatGptAccountsDialog } from '@/features/providers/chatgpt-accounts-dialog';
import { MODEL_SELECTOR_PROVIDER_IDS, ProviderLogo } from '@/features/providers/provider-branding';
import { isLlmGatewayEnabled } from '@/lib/llm-gateway';
import { cn } from '@/lib/utils';
import type { ProviderModalTab } from '@/stores/provider-modal-store';
import { useProviderModalStore } from '@/stores/provider-modal-store';
import { getProjectDetail } from '@kortix/sdk';
import {
  contract, qk, type ProviderListResponse, useFeatureFlag, useModelAccess, useModelStore,
} from '@kortix/sdk/react';
import {
  CheckIcon as Check,
  CaretDownIcon as ChevronDown,
  CaretRightIcon as CaretRight,
  CreditCardIcon as CreditCard,
  KeyIcon as KeyRound,
  PlusIcon as Plus,
  SlidersHorizontalIcon as SlidersHorizontal,
  StarIcon as Star,
} from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from '@/i18n/use-translations';
import { useParams } from 'next/navigation';
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { resolveAvailableSelectedModel } from './model-availability';
import {
  isPickerGroupOpen,
  modelItemValue,
  pickerGroupId,
  pickerGroupLabel,
  buildPickerSections,
  splitModelLabel,
} from './model-grouping';
import { modelInDefaultView } from './model-picker-default-view';
import { isSubscriptionModel, pickerModelName, shouldShowFreeTag } from './model-tags';
import type { FlatModel } from './session-chat-input';
import { useModelConnectionGate } from './use-model-connection-gate';

// Re-export for consumers
export { Tag };

export function ConnectProviderDialog({
  open,
  onOpenChange,
  providers: _providers,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  providers: ProviderListResponse | undefined;
}) {
  const { openProviderModal, closeProviderModal } = useProviderModalStore();

  useEffect(() => {
    if (open) openProviderModal('providers');
    else closeProviderModal();
  }, [open, openProviderModal, closeProviderModal]);

  const isStoreOpen = useProviderModalStore((s) => s.isOpen);
  useEffect(() => {
    if (!isStoreOpen && open) onOpenChange(false);
  }, [isStoreOpen, open, onOpenChange]);

  return null;
}

import Hint from '@/components/ui/hint';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectPageCans } from '@/lib/use-project-can';
import { Tag } from '@/components/ui/tag';

type ModelRef = { providerID: string; modelID: string };

/**
 * The one default this picker sets: the ACCOUNT default model, from the star on
 * a row. It is the default for every member of the account, so it needs
 * `project.customize.write` and the star is hidden without it.
 *
 * The other two scopes are gone from here, not lost — each already had a
 * better home, on the screen that owns the thing being defaulted:
 *
 *  - **Project default** → the provider modal's Models tab
 *    (`llm-provider/models-tab.tsx`), which stars a row AND badges the current
 *    one `project default`, AND explains why that row's switch is locked.
 *  - **Agent default** → the agent's own detail page
 *    (`capabilities/agents/agent-detail-aside.tsx`'s `AgentModel`), which also
 *    offers the "Reset to default" this footer never had.
 *
 * Three buttons stacked under a model list could set a default at three scopes
 * with nothing on screen saying which was in force at any of them. Do not add
 * them back here.
 */
export interface ModelDefaultControls {
  /**
   * Which model is the account default right now, so a row can SHOW it with a
   * filled star. Without it the star is a button you press into silence — no
   * confirmation, and no way to tell you are re-setting what is already set.
   */
  accountDefault?: ModelRef | null;
  onSetAccountDefault: (model: ModelRef) => void;
}

/**
 * One model row.
 *
 * Extracted because it renders in TWO places now — the pinned "Your default"
 * section and the provider group the model actually belongs to — and ninety
 * lines of JSX copied twice is ninety lines that drift.
 *
 * `groupProviderID` is the RESOLVED provider (`pickerGroupId`), never
 * `model.providerID`: under the gateway every model is registered as `kortix`,
 * so the model's own id would paint the Kortix mark on every row.
 */
function ModelRow({
  model,
  groupProviderID,
  groupProviderName,
  isSelected,
  isAccountDefault,
  defaultControls,
  onSelect,
  scope,
  showSubscriptionTag = true,
}: {
  model: FlatModel;
  groupProviderID: string;
  groupProviderName: string;
  isSelected: boolean;
  isAccountDefault: boolean;
  defaultControls?: ModelDefaultControls;
  onSelect: (model: FlatModel) => void;
  /** Which copy of the model this is — see `modelItemValue`. The pinned copy
   *  and the in-group copy must not share a cmdk value. */
  scope: 'pinned' | 'model';
  /** False inside a section whose heading already names the billing, so the
   *  same fact is not repeated on every row. */
  showSubscriptionTag?: boolean;
}) {
  const t = useTranslations('modelSelector');
  const isFree = shouldShowFreeTag(model);
  const isSubscription = isSubscriptionModel(model);
  // Display name only — `model.modelName` still carries " (ChatGPT)" for search
  // and for the aria labels below, where there is no group heading to lean on.
  const { lead, trail } = splitModelLabel(pickerModelName(model));

  return (
    <CommandItem
      value={modelItemValue(scope, model)}
      /*
        `group` so the trailing slot can react to this row's hover AND to
        cmdk's keyboard highlight, which lands as `data-selected` here.

        The two `bg-*` overrides are a FIX, not a preference. `CommandItem`
        paints its hover and highlight with `bg-accent`, and in the dark theme
        `--accent` and `--popover` resolve to the same surface token in dark mode,
        so the row highlight was mathematically
        invisible against the popover it sits on. Light mode was fine, which is
        why it read as "sometimes there's a hover". `--hover` and `--active` are
        the tokens the design system defines for exactly this — a transient
        tint and a persistent selected fill, both ink-on-surface at a fixed
        alpha, so they cannot collide with whatever surface they land on.
      */
      className={cn(
        'group py-1',
        // Same `data-nav` scope as `CommandItem`'s own selected classes, so
        // tailwind-merge replaces them instead of stacking a second selector.
        'hover:bg-hover [&:not([data-nav=pointer]_*)]:data-[selected=true]:bg-hover',
        isSelected && 'bg-active [&:not([data-nav=pointer]_*)]:data-[selected=true]:bg-active',
      )}
      /* The raw id no longer has a line of its own. It is still the only way to
         tell two same-named models apart, so it stays reachable on hover
         instead of costing every row a second line. */
      title={model.modelID}
      onSelect={() => onSelect(model)}
    >
      <ProviderLogo
        providerID={groupProviderID}
        name={groupProviderName}
        size="small"
        /* Stripped of the tinted tile so it reads as a mark on the row, not a
           chip — `cn` puts these last, so they win over the component's own
           `bg-zinc-*`. */
        className="size-4 rounded-none bg-transparent"
      />

      <span className="min-w-0 flex-1 truncate leading-tight">
        <span className="text-foreground font-medium">{lead}</span>
        {trail ? <span className="text-muted-foreground font-normal"> {trail}</span> : null}
      </span>

      {/*
        ONE tag per row. A subscription model is billed to the connected ChatGPT
        account instead of metered per token, and that is the only thing the two
        copies of e.g. "GPT-6 Astra" do not share — so it is what the tag says.
        Neutral on purpose: this is metadata, not status, and the seven
        `kortix-*` accents are reserved for state.
      */}
      {isFree ? (
        <Tag variant="free">{t('free')}</Tag>
      ) : isSubscription && showSubscriptionTag ? (
        <Tag>{t('included')}</Tag>
      ) : null}

      {/*
        ONE trailing slot, always the same 24px wide, so swapping what sits in
        it never shifts the name beside it and every row truncates at the same
        column. Two rules decide what sits in it:

        AT REST, being the selected model outranks being the default. The check
        answers "which model am I about to send to", which is the question the
        list is open to answer; the star answers "which one do new sessions
        start on", which is a setting. So a row that is BOTH shows the check —
        the star is one hover away.

        A default that is NOT the selected model has an empty slot to use, so it
        keeps its filled star at rest — otherwise nothing on screen would say
        which model your sessions actually start on.

        ── The swap is INSTANT, and that is deliberate ──

        This used to cross-fade: the star faded in over 150ms and the check
        faded out over 100ms. Dragging the cursor down the list left a trail of
        stars at every opacity between 0 and 1 — five or six rows mid-fade
        at once, none of them the row under the cursor. It read as flicker
        because it WAS flicker. Two causes, both fixed by removing the fade:

          1. FREQUENCY. This is a row you sweep past, not a surface you open. A
             150ms reveal is still running when the cursor is three rows further
             down, so the animation never describes where the pointer is.
          2. TWO TRIGGERS, ONE PROPERTY. The reveal fires from `:hover` AND from
             cmdk's `data-selected` (a pointermove loop; the CSS hover is the
             fallback for pages that swallow pointermove — see `command.tsx`).
             They do not drop together: hover ends when you leave,
             `data-selected` persists until another row claims it. Two sources
             easing one opacity in opposite directions is what "comes and goes
             and comes back" looks like.

        The row's own background swaps immediately from those same two
        triggers, so the star now matches the row it belongs to. What still
        animates is what cannot trail: colour and background on the icon the
        cursor is actually over, and the press scale. Do not put `opacity` back
        in that property list.
      */}
      <span className="relative flex size-6 shrink-0 items-center justify-center">
        {isSelected && (
          <Check className="text-foreground size-4 group-hover:opacity-0 group-data-[selected=true]:opacity-0" />
        )}

        {defaultControls && (
          <button
            type="button"
            aria-label={
              isAccountDefault
                ? t('defaultAria', { model: model.modelName })
                : t('setDefaultAria', { model: model.modelName })
            }
            title={isAccountDefault ? t('defaultTitle') : t('setDefaultTitle')}
            /* No `aria-pressed`: that promises a toggle, and clicking the
               filled star does nothing. Clearing an account default is a real
               action with a real fallback behind it, and it belongs where the
               default is managed, not on a hover affordance. */
            /* cmdk highlights on pointer move and selects on the item's own
               click. Stopping both here keeps "star this" from also meaning
               "switch to this" — the popover stays open so a default can be set
               without losing the list. */
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              if (isAccountDefault) return;
              defaultControls.onSetAccountDefault({
                providerID: model.providerID,
                modelID: model.modelID,
              });
            }}
            className={cn(
              'absolute inset-0 flex cursor-pointer items-center justify-center rounded-md',
              'text-muted-foreground/70 hover:text-foreground hover:bg-foreground/10',
              /* `opacity` is NOT in this list, on purpose — see above. These
                 only ever run on the one row the cursor is on, so they cannot
                 leave a trail. */
              'duration-normal transition-[color,background-color,transform] ease-out',
              /* Press feedback, only where a press does something — the
                 already-default star is a no-op, and a control that recoils
                 under the finger while changing nothing is a worse lie than no
                 feedback. `motion-safe` so reduced motion loses the movement
                 and keeps every colour cue, rather than losing both. */
              !isAccountDefault && 'motion-safe:active:scale-[0.96]',
              /* Hidden means BOTH invisible and unclickable — an opacity-0
                 button still takes clicks, which would put a dead hit target
                 over the row's own click area. Focus is unaffected by
                 pointer-events, so the keyboard path still reaches it. */
              'pointer-events-none opacity-0',
              'group-hover:pointer-events-auto group-hover:opacity-100',
              'group-data-[selected=true]:pointer-events-auto group-data-[selected=true]:opacity-100',
              'focus-visible:pointer-events-auto focus-visible:opacity-100',
              /* A 0.6px ring with `outline-none` is not a focus indicator —
                 on a 1x display it rounds away entirely, so keyboard users
                 tabbing to the default-star had no visible target at all. */
              'focus-visible:ring-kortix-base focus-visible:ring-2 focus-visible:outline-none',
              /* The default keeps its star at rest ONLY when the check is not
                 already using the slot. Selected wins; see above. */
              isAccountDefault && 'text-foreground cursor-default hover:bg-transparent',
              isAccountDefault && !isSelected && 'pointer-events-auto opacity-100',
            )}
          >
            {/* `weight="fill"` or no weight at all — Phosphor's `regular` IS the
                default, so passing it made the two states read as a deliberate
                pair when only one of them says anything. */}
            {isAccountDefault ? (
              <Star weight="fill" className="size-3.5" />
            ) : (
              <Star className="size-3.5" />
            )}
          </button>
        )}
      </span>
    </CommandItem>
  );
}

/** A section heading in the picker — plain muted text. The colour lives on this
 *  span rather than as a `[&_[cmdk-group-heading]]` override because
 *  `CommandGroup` sets `text-foreground` on the heading element itself; a child
 *  wins on its own colour without a specificity fight. */
function GroupHeading({ children }: { children: React.ReactNode }) {
  return <span className="text-muted-foreground font-medium tracking-wide">{children}</span>;
}

export interface ModelSelectorProps {
  models: FlatModel[];
  selectedModel: { providerID: string; modelID: string } | null;
  onSelect: (model: { providerID: string; modelID: string } | null) => void;
  providers?: ProviderListResponse;
  defaultControls?: ModelDefaultControls;
  unsetLabel?: string;
  disabled?: boolean;
  modelsLoading?: boolean;
  triggerLabelClassName?: string;

  projectId?: string;

  /**
   * Offer the member's own ChatGPT subscription (pooled provider secrets) at
   * the end of the list. Only an interactive session can use a personal
   * account; a scheduled or background run cannot, so its pickers leave this off.
   */
  offerChatGptAccounts?: boolean;

  /**
   * Controlled open state. Omit for the normal case — the trigger owns its
   * own popover and nothing changes.
   *
   * This exists so the composer's `/` palette can open this popover for its
   * "Switch model" row (`composer.tsx`'s `handleSelectAction`). That row
   * previously did nothing at all: the menu closed, the editor refocused, and
   * the picker stayed shut, because this component's `open` was internal
   * state with no way in.
   *
   * "Set reasoning effort" does not route here — it opens the toolbar's
   * `ReasoningEffortSelector`, which sets the session variant.
   *
   * Controlled/uncontrolled is decided by whether `open` is `undefined`, the
   * same rule Radix itself uses — so every existing call site keeps its
   * internal state untouched.
   */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function ModelSelector({
  models,
  selectedModel,
  onSelect,
  defaultControls,
  unsetLabel,
  disabled = false,
  modelsLoading = false,
  triggerLabelClassName,
  offerChatGptAccounts = false,
  open: openProp,
  onOpenChange,
}: ModelSelectorProps) {
  const tModel = useTranslations('modelSelector');
  const t = useTranslations('threads');

  // Controlled when `open` is supplied, uncontrolled otherwise — Radix's own
  // rule. `setOpen` below is the single write path every internal caller
  // already goes through (`setOpen(false)` after picking a model or a
  // default), so a controlled parent hears about those closes too rather than
  // being silently desynced from a popover that shut itself.
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const isControlled = openProp !== undefined;
  const open = isControlled ? openProp : uncontrolledOpen;
  const setOpen = useCallback(
    (next: boolean) => {
      if (!isControlled) setUncontrolledOpen(next);
      onOpenChange?.(next);
    },
    [isControlled, onOpenChange],
  );

  const [search, setSearch] = useState('');
  const [toggledGroups, setToggledGroups] = useState<ReadonlyMap<string, boolean>>(new Map());
  const {
    openConnectProvider,
    openUpgrade,
    modal: connectionModal,
    entitlementsPending,
    isSelectableModel,
    showUpgradeOption,
  } = useModelConnectionGate(models);

  const params = useParams<{ id?: string }>();
  const projectId = typeof params?.id === 'string' ? params.id : null;
  const projectDetailQuery = useQuery({
    queryKey: qk.project.detail(projectId ?? ''),
    queryFn: () => getProjectDetail(projectId as string),
    enabled: !!projectId,
    ...contract('config'),
  });
  const llmGatewayEnabled = isLlmGatewayEnabled(projectDetailQuery.data?.project);
  // Bring your own ChatGPT subscription (pooled provider secrets). Any member
  // connects their own account from here; Customize is not needed. Hidden when
  // a manager disabled the ChatGPT provider for the project.
  const tPooled = useTranslations('pooledSecrets');
  const pooledSecrets = useFeatureFlag(projectId, 'pooled_provider_secrets');
  const chatGptPossible =
    offerChatGptAccounts && !!projectId && pooledSecrets.enabled && llmGatewayEnabled;
  const modelAccess = useModelAccess(chatGptPossible ? projectId : null);
  const chatGptAvailable =
    chatGptPossible && !(modelAccess.data?.disabledProviders ?? []).includes('codex');
  const [chatGptOpen, setChatGptOpen] = useState(false);
  // Every write this picker offers is `project.customize.write` on the API: the
  // star sets the ACCOUNT default (the default for every member, not a personal
  // one), and "+" / sliders open the provider modal. A member without the leaf
  // got a "You don't have permission" toast for each. Hidden on a RECEIVED
  // denial only, from the shared project-page probe batch.
  const caps = useProjectPageCans(projectId ?? undefined);
  const canManageModels =
    !projectId || caps[PROJECT_ACTIONS.PROJECT_CUSTOMIZE_WRITE]?.allowed !== false;
  const rowDefaultControls = canManageModels ? defaultControls : undefined;
  const baseModels = useMemo(() => {
    return llmGatewayEnabled ? models : models.filter((m) => m.providerID !== 'kortix');
  }, [models, llmGatewayEnabled]);

  const availableSelectedModel = entitlementsPending
    ? selectedModel
    : resolveAvailableSelectedModel(selectedModel, isSelectableModel);
  const current = baseModels.find(
    (m) =>
      m.providerID === availableSelectedModel?.providerID &&
      m.modelID === availableSelectedModel?.modelID,
  );
  const displayName = current?.modelName || unsetLabel || t('noModel');

  useEffect(() => {
    if (!open) {
      setSearch('');
      // Back to the defaults on every open. A section the user toggled last
      // time is not a preference they set; carrying it would make the
      // picker's height depend on history.
      setToggledGroups(new Map());
    }
  }, [open]);

  // The store's visibility rule (newest per family + flagships + user pins)
  // curates the NO-SEARCH view for native providers — the client twin of the
  // `enabled` stamping `/model-picker` gives gateway catalogs. See
  // modelInDefaultView.
  const pickerModelStore = useModelStore(baseModels);
  const visibleModels = useMemo(() => {
    const q = search.toLowerCase();
    return baseModels
      .filter(
        (m) =>
          m.enabled !== false &&
          (!q ||
            (m.modelName || '').toLowerCase().includes(q) ||
            (m.modelID || '').toLowerCase().includes(q) ||
            (m.providerName || '').toLowerCase().includes(q)) &&
          modelInDefaultView(m, {
            search,
            isStoreVisible: pickerModelStore.isVisible,
            selected: selectedModel,
          }),
      )
      .sort((a, b) => a.modelName.localeCompare(b.modelName));
  }, [baseModels, search, pickerModelStore.isVisible, selectedModel]);

  /** Is there anything to pick AT ALL, ignoring the search box? The empty
   *  state below branches on this: "no models match your search" and "you have
   *  no models" are different problems with different ways out. */
  const hasAnyModel = useMemo(() => baseModels.some((m) => m.enabled !== false), [baseModels]);
  /** Does this member already have ChatGPT subscription models? Then the row
   *  manages their accounts instead of offering to connect one. */
  const hasChatGptModels = useMemo(
    () => baseModels.some((m) => m.enabled !== false && pickerGroupId(m) === 'codex'),
    [baseModels],
  );

  const grouped = useMemo(() => {
    const groups = new Map<
      string,
      { providerName: string; providerID: string; models: FlatModel[] }
    >();
    for (const m of visibleModels) {
      const groupID = llmGatewayEnabled ? pickerGroupId(m) : m.providerID;
      const existing = groups.get(groupID);
      if (existing) {
        existing.models.push(m);
      } else {
        groups.set(groupID, {
          providerID: groupID,
          // NEVER `m.providerName` here — under the gateway it's always
          // "Kortix" (opencode's raw provider name), which is exactly the
          // "every provider shows as Kortix" bug. Label by the resolved real
          // provider id instead. See pickerGroupLabel's doc comment.
          providerName: llmGatewayEnabled ? pickerGroupLabel(groupID, m) : m.providerName,
          models: [m],
        });
      }
    }
    const entries = Array.from(groups.values());
    entries.sort((a, b) => {
      const ai = MODEL_SELECTOR_PROVIDER_IDS.indexOf(a.providerID);
      const bi = MODEL_SELECTOR_PROVIDER_IDS.indexOf(b.providerID);
      if (ai >= 0 && bi < 0) return -1;
      if (ai < 0 && bi >= 0) return 1;
      if (ai >= 0 && bi >= 0) return ai - bi;
      return a.providerName.localeCompare(b.providerName);
    });
    return entries;
  }, [visibleModels, llmGatewayEnabled]);

  /** Provider groups, with any multi-credential provider split per account. */
  const searching = search.trim().length > 0;

  const sections = useMemo(
    () => buildPickerSections(grouped),
    [grouped],
  );

  /**
   * The account default, lifted to the top of the list in its own section.
   *
   * The picker's job for a non-technical user is "pick the one I use", and
   * before this that model was somewhere inside an alphabetical provider group
   * with no way to find it except by already knowing its name. Pinning it costs
   * one row and removes the hunt.
   *
   * Resolved against `visibleModels`, not the raw list, so it obeys the search
   * box and the enablement filter — a default the project has since turned off
   * does not get a section of its own claiming otherwise, and typing a query it
   * does not match does not leave it stranded at the top. `groupID` matches how
   * the model is grouped below so the pinned copy shows the same provider mark.
   */
  const pinnedDefault = useMemo(() => {
    const ref = defaultControls?.accountDefault;
    if (!ref) return null;
    const model = visibleModels.find(
      (m) => m.providerID === ref.providerID && m.modelID === ref.modelID,
    );
    if (!model) return null;
    const groupID = llmGatewayEnabled ? pickerGroupId(model) : model.providerID;
    return {
      model,
      providerID: groupID,
      providerName: llmGatewayEnabled ? pickerGroupLabel(groupID, model) : model.providerName,
    };
  }, [defaultControls?.accountDefault, llmGatewayEnabled, visibleModels]);

  const handleSelect = useCallback(
    (model: FlatModel) => {
      onSelect({ providerID: model.providerID, modelID: model.modelID });
      setOpen(false);
    },
    [onSelect, setOpen],
  );

  const handleOpenProviderModal = useCallback(
    (tab: ProviderModalTab) => {
      setOpen(false);
      openConnectProvider(tab);
    },
    [openConnectProvider, setOpen],
  );

  const handleUpgrade = useCallback(() => {
    setOpen(false);
    openUpgrade();
  }, [openUpgrade, setOpen]);

  const handleOpenChatGpt = useCallback(() => {
    setOpen(false);
    setChatGptOpen(true);
  }, [setOpen]);

  return (
    <>
      {connectionModal}
      {projectId && chatGptPossible && (
        <ChatGptAccountsDialog projectId={projectId} open={chatGptOpen} onOpenChange={setChatGptOpen} />
      )}
      <CommandPopover
        open={disabled ? false : open}
        onOpenChange={(next) => !disabled && setOpen(next)}
      >
        <CommandPopoverTrigger>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-muted-foreground rounded-lg"
          >
            <span className={cn('max-w-30 truncate', triggerLabelClassName)}>{displayName}</span>
            <ChevronDown
              className={cn(
                'duration-moderate size-3 transition-transform ease-out',
                open && 'rotate-180',
              )}
            />
          </Button>
        </CommandPopoverTrigger>

        {/* `min(...)`, not a hard `300px`: on a 320px viewport a fixed 300px
            popover plus the trigger's own inset pushed the panel off-screen.
            Same shape `mention-menu.tsx` uses. */}
        <CommandPopoverContent
          side="top"
          align="start"
          sideOffset={8}
          className="w-[min(300px,calc(100vw-1.5rem))]"
        >
          <>
            <CommandInput
              compact
              placeholder={tModel('search')}
              value={search}
              onValueChange={setSearch}
              rightElement={
                canManageModels ? (
                <div className="-mr-0.5 flex shrink-0 items-center gap-0.5">
                  <Hint label={tModel('connectProvider')} side="top" className="z-50">
                    <button
                      type="button"
                      aria-label={tModel('addProvider')}
                      onClick={() => handleOpenProviderModal('providers')}
                      className="text-muted-foreground hover:text-foreground hover:bg-muted flex size-8 cursor-pointer items-center justify-center rounded-md transition-colors"
                    >
                      <Plus className="size-4" />
                    </button>
                  </Hint>
                  <Hint label={tModel('manageModels')} side="top" className="z-50">
                    <button
                      type="button"
                      aria-label={tModel('manageModels')}
                      onClick={() => handleOpenProviderModal('models')}
                      className="text-muted-foreground hover:text-foreground hover:bg-muted flex size-8 cursor-pointer items-center justify-center rounded-md transition-colors"
                    >
                      <SlidersHorizontal className="size-4" />
                    </button>
                  </Hint>
                </div>
                ) : undefined
              }
            />

            {/* Same condition as the group headings below: with one group the
                input's own `border-b` (command.tsx) is the only divider —
                adding this too stacks a doubled hairline. With 2+ groups the
                sectioned list earns the stronger edge under the input. */}
            {grouped.length > 1 && <CommandSeparator className="bg-border/60" />}

            <CommandList className="max-h-[380px]">
              {modelsLoading || entitlementsPending ? (
                <div
                  className="flex min-h-32 items-center justify-center"
                  role="status"
                  aria-label={tModel('loading')}
                >
                  <Loading className="text-muted-foreground size-4 shrink-0" />
                </div>
              ) : grouped.length > 0 ? (
                <>
                  {pinnedDefault && (
                    <>
                      {/* The model you chose, first, so it never has to be
                          hunted for in a provider group. Deliberately a COPY —
                          it also stays in its own provider section below, so
                          that section is never missing a model, and the star
                          in both places is the same fact. */}
                      <CommandGroup
                        heading={<GroupHeading>{tModel('yourDefault')}</GroupHeading>}
                        forceMount
                      >
                        <ModelRow
                          model={pinnedDefault.model}
                          groupProviderID={pinnedDefault.providerID}
                          groupProviderName={pinnedDefault.providerName}
                          isSelected={
                            availableSelectedModel?.providerID === pinnedDefault.model.providerID &&
                            availableSelectedModel?.modelID === pinnedDefault.model.modelID
                          }
                          isAccountDefault
                          defaultControls={rowDefaultControls}
                          onSelect={handleSelect}
                          scope="pinned"
                        />
                      </CommandGroup>
                      <CommandSeparator />
                    </>
                  )}

                  {sections.map((section, sectionIndex) => {
                    const selectedInSection = section.models.find(
                      (m) =>
                        availableSelectedModel?.providerID === m.providerID &&
                        availableSelectedModel?.modelID === m.modelID,
                    );
                    const open = isPickerGroupOpen({
                      groupIndex: sectionIndex,
                      groupProviderID: section.id,
                      hasSearch: searching,
                      containsSelected: !!selectedInSection,
                      toggled: toggledGroups,
                    });
                    // Records the flip of what is on screen, so collapsing a
                    // default-open group (the managed set, or the one holding
                    // the selected model) works like collapsing any other.
                    const toggle = () =>
                      setToggledGroups((prev) => new Map(prev).set(section.id, !open));
                    const collapsible = sections.length > 1;
                    return (
                      <Fragment key={section.id}>
                        {sectionIndex > 0 && <CommandSeparator />}
                        <CommandGroup forceMount>
                          {/* The LABEL is the control: the provider's name
                              expands and collapses its own models, rather than
                              a separate "show N models" row underneath it.
                              Every section gets the same header, the managed
                              set included. A lone section has nothing to
                              collapse against, so it gets no header. */}
                          {collapsible && (
                            <CommandItem
                              value={`section-${section.id}`}
                              onSelect={toggle}
                              className="cursor-pointer"
                            >
                              {open ? (
                                <ChevronDown className="text-muted-foreground size-3.5 shrink-0" />
                              ) : (
                                <CaretRight className="text-muted-foreground size-3.5 shrink-0" />
                              )}
                              <span className="min-w-0 truncate text-sm font-medium">
                                {section.label}
                              </span>
                              <span className="flex-1" />
                              {/* Said once for the section, not once per row:
                                  every model under a subscription heading is
                                  billed the same way. */}
                              {section.models.some(isSubscriptionModel) && (
                                <Tag>{tModel('included')}</Tag>
                              )}
                              {/* A collapsed group that holds the selected
                                  model names it, so collapsing never hides
                                  what you are on. */}
                              {!open && selectedInSection && (
                                <>
                                  <span className="text-muted-foreground min-w-0 truncate text-xs">
                                    {pickerModelName(selectedInSection)}
                                  </span>
                                  <Check className="text-foreground size-4 shrink-0" />
                                </>
                              )}
                              {!open && !selectedInSection && (
                                <span className="text-muted-foreground text-xs tabular-nums">
                                  {section.models.length}
                                </span>
                              )}
                            </CommandItem>
                          )}
                          {open &&
                            section.models.map((model) => (
                              <ModelRow
                                key={`${section.id}:${model.providerID}:${model.modelID}`}
                                model={model}
                                groupProviderID={section.providerID}
                                groupProviderName={section.label}
                                isSelected={
                                  availableSelectedModel?.providerID === model.providerID &&
                                  availableSelectedModel?.modelID === model.modelID
                                }
                                isAccountDefault={
                                  defaultControls?.accountDefault?.providerID === model.providerID &&
                                  defaultControls?.accountDefault?.modelID === model.modelID
                                }
                                defaultControls={rowDefaultControls}
                                onSelect={handleSelect}
                                scope="model"
                                showSubscriptionTag={false}
                              />
                            ))}
                        </CommandGroup>
                      </Fragment>
                    );
                  })}
                  {/* The member's own way in to ChatGPT: connect a subscription,
                      or manage the accounts behind the ChatGPT section above.
                      Not a search result, so it stays out of a filtered list. */}
                  {chatGptAvailable && !searching && (
                    <>
                      <CommandSeparator />
                      <CommandGroup forceMount>
                        <CommandItem
                          value="chatgpt-subscription"
                          onSelect={handleOpenChatGpt}
                          className="cursor-pointer"
                        >
                          <ProviderLogo
                            providerID="codex"
                            name="ChatGPT"
                            size="small"
                            className="size-4 rounded-none bg-transparent"
                          />
                          <span className="text-foreground min-w-0 flex-1 truncate text-sm font-medium">
                            {hasChatGptModels
                              ? tPooled('manageChatGptAccounts')
                              : tPooled('useYourChatGpt')}
                          </span>
                          {!hasChatGptModels && (
                            <span className="text-muted-foreground text-xs">{tPooled('connect')}</span>
                          )}
                        </CommandItem>
                      </CommandGroup>
                    </>
                  )}
                </>
              ) : hasAnyModel ? (
                /* Models ARE connected — the SEARCH matched none of them.
                   `grouped` is built from `visibleModels`, which is already
                   filtered by `search`, so the branch below could not tell the
                   two apart: typing "zzz" with 40 models connected showed
                   "No models available" and a Connect-provider CTA. */
                <div className="px-3 py-5 text-center">
                  <div className="text-foreground text-sm font-medium">
                    {tModel('noMatch.title')}
                  </div>
                  <p className="text-muted-foreground mx-auto mt-1 max-w-[220px] text-xs leading-5">
                    {tModel('noMatch.description', { search: search.trim() })}
                  </p>
                  <div className="mt-4 flex items-center justify-center">
                    <Button type="button" size="xs" variant="outline" onClick={() => setSearch('')}>
                      {tModel('noMatch.clear')}
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="px-3 py-5 text-center">
                  <div className="text-foreground text-sm font-medium">{tModel('empty.title')}</div>
                  <p className="text-muted-foreground mx-auto mt-1 max-w-[220px] text-xs leading-5">
                    {showUpgradeOption
                      ? tModel('empty.upgradeDescription')
                      : tModel('empty.description')}
                  </p>
                  <div className="mt-4 flex items-center justify-center gap-2">
                    {showUpgradeOption && (
                      <Button type="button" size="xs" onClick={handleUpgrade}>
                        <CreditCard className="size-3.5" />
                        {tModel('upgrade')}
                      </Button>
                    )}
                    <Button
                      type="button"
                      size="xs"
                      variant={showUpgradeOption ? 'outline' : 'default'}
                      onClick={() => handleOpenProviderModal('providers')}
                    >
                      <KeyRound className="size-3.5" />
                      {tModel('connectProvider')}
                    </Button>
                    {chatGptAvailable && (
                      <Button type="button" size="xs" variant="outline" onClick={handleOpenChatGpt}>
                        {tPooled('connectChatGpt')}
                      </Button>
                    )}
                  </div>
                </div>
              )}
            </CommandList>
          </>
        </CommandPopoverContent>
      </CommandPopover>
    </>
  );
}
