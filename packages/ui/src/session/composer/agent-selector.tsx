'use client';

import { Badge } from '../../primitives/badge';
import { Button } from '../../primitives/button';
import {
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandPopover,
  CommandPopoverContent,
  CommandPopoverTrigger,
  CommandSeparator,
} from '../../primitives/command';
import Hint from '../../primitives/hint';
import { useTranslations } from '../../i18n';
import { useUiHostConfig } from '../../providers/ui-provider';
import { cn } from '../../lib/utils';
import { TRIGGER_CARET_CLASS, triggerVariants } from '../../primitives/trigger-variants';
import type { Agent } from '@kortix/sdk/react';
import { capitalizeWords, isMetaAgentName, META_AGENT_DISPLAY_NAME } from '@kortix/shared';
import { CaretDownIcon, CheckIcon } from '@phosphor-icons/react';
import { AgentMark } from '../../internal/components/agent-mark';
import { useEffect, useMemo, useState } from 'react';
import { composerSelectableAgents } from './composer-agent-access';

/**
 * Agents on screen before the popover grows a search field.
 *
 * The list caps at 320px and a row is two lines (~48px), so roughly six fit
 * without scrolling. Up to that point the whole set is readable in one glance
 * and a search field is pure chrome — it costs a row of height and a focus
 * stop to filter something the eye has already finished reading. Past it,
 * scanning becomes scrolling and search starts paying for itself.
 */
const SEARCH_MIN_AGENTS = 7;

/**
 * The agent a selector shows: the selected one, even before the roster has it,
 * else the first selectable agent. One rule for the trigger and the chat composer.
 */
function resolveDisplayedAgentName(primaryAgents: Agent[], selectedAgent: string | null) {
  const current = primaryAgents.find((a) => a.name === selectedAgent);
  return current?.name ?? selectedAgent ?? primaryAgents[0]?.name;
}

/** The label `AgentSelector` shows for a selection (null = nothing picked). Other surfaces that name the agent reuse it. */
export function agentDisplayLabel(agents: Agent[], selectedAgent: string | null): string {
  const name = resolveDisplayedAgentName(composerSelectableAgents(agents), selectedAgent);
  if (!name) return 'Agent';
  return isMetaAgentName(name) ? META_AGENT_DISPLAY_NAME : capitalizeWords(name);
}

export function AgentSelector({
  agents,
  selectedAgent,
  onSelect,
  disabled = false,
  triggerLabelClassName,
  unavailableHint,
  open: controlledOpen,
  onOpenChange,
  appearance = 'chip',
}: {
  agents: Agent[];
  selectedAgent: string | null;
  onSelect: (agentName: string | null) => void;
  disabled?: boolean;
  triggerLabelClassName?: string;
  /**
   * Why there is nothing to pick — shown as the tooltip on the inert trigger.
   *
   * Set only for a roster that loaded EMPTY because this user holds no agent
   * grant. An empty list with no hint is the ordinary not-loaded-yet state and
   * says nothing, because there is nothing true to say yet.
   */
  unavailableHint?: string | null;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /**
   * `chip` is the composer's borderless toolbar chip. `field` is a form field:
   * the full-width `h-9` box every `SelectTrigger` in a form draws, so the
   * picker reads as one more field instead of a chip inside a frame.
   */
  appearance?: 'chip' | 'field';
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const t = useTranslations('threads');
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = onOpenChange ?? setInternalOpen;
  const [search, setSearch] = useState('');

  const { offeredAgents, agentLabels } = useUiHostConfig();
  // A host that lists its agents (`offeredAgents`) offers only those; it names them with `agentLabels`.
  const offered = useMemo(
    () => {
      if (!offeredAgents) return agents;
      const offeredNames = new Set(offeredAgents);
      return agents.filter((a) => offeredNames.has(a.name));
    },
    [agents, offeredAgents],
  );
  const primaryAgents = useMemo(() => composerSelectableAgents(offered), [offered]);
  const label = (name: string) =>
    agentLabels?.[name] ?? (isMetaAgentName(name) ? META_AGENT_DISPLAY_NAME : capitalizeWords(name));

  // A `flash` state, a `prevAgentRef` feeding it, two effects and a 400ms
  // timer used to live here. Nothing ever READ `flash` — it was written on
  // every agent change and rendered nowhere, so the whole apparatus bought a
  // re-render and a timer per selection and showed the user nothing.

  useEffect(() => {
    if (!open) setSearch('');
  }, [open]);

  const filteredPrimary = useMemo(() => {
    const q = search.toLowerCase().trim();
    if (!q) return primaryAgents;
    return primaryAgents.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        (agentLabels?.[a.name] ?? '').toLowerCase().includes(q) ||
        (a.description || '').toLowerCase().includes(q),
    );
  }, [primaryAgents, search, agentLabels]);

  const filteredMeta = useMemo(
    () => filteredPrimary.filter((a) => isMetaAgentName(a.name)),
    [filteredPrimary],
  );
  const filteredProject = useMemo(
    () => filteredPrimary.filter((a) => !isMetaAgentName(a.name)),
    [filteredPrimary],
  );

  // Keyed off the FULL list, never the filtered one: deriving it from
  // `filteredPrimary` would make the field that is doing the filtering vanish
  // the moment a query narrowed the list past the threshold, taking the
  // user's own query with it.
  const showSearch = primaryAgents.length >= SEARCH_MIN_AGENTS;

  // The trigger names the agent that will RUN, which is `selectedAgent` even
  // when the roster does not (yet) contain it: a session bound to `kortix`
  // must read "Kortix" while the roster query is still in flight, not whatever
  // happens to be first in someone else's list. The `primaryAgents[0]`
  // fallback stays only for a truly unresolved selection (no name at all),
  // matching the resolver's own first-accessible pre-selection.
  const displayedName = resolveDisplayedAgentName(primaryAgents, selectedAgent);
  const displayName = displayedName ? label(displayedName) : agentDisplayLabel(offered, selectedAgent);
  // The trigger leads with the agent's pixel mark, the same face it has on the
  // Agents page and in every row below. Only for a real agent: a placeholder
  // name such as a trigger's `default` would get a mark of its own, and that
  // face would belong to no agent.
  const triggerMark =
    displayedName && primaryAgents.some((agent) => agent.name === displayedName) ? (
      <AgentMark slug={displayedName} />
    ) : null;
  const field = appearance === 'field';
  const fieldTrigger = (caret: boolean, props: { disabled?: boolean; 'aria-label'?: string }) => (
    <button type="button" className={cn(triggerVariants(), 'h-9 w-full')} {...props}>
      <span className="flex min-w-0 items-center gap-2">
        {triggerMark}
        <span className="truncate">{displayName}</span>
      </span>
      {caret ? <CaretDownIcon className={cn(TRIGGER_CARET_CLASS, 'size-4')} /> : null}
    </button>
  );

  /**
   * One agent: name, its type, its description, and a check when it is the
   * one in use.
   *
   * The type is a `Badge` on the row rather than a `CommandGroup` heading.
   * Headings only earn their place when there is more than one section to
   * tell apart, and there usually is not — most projects have no meta agents
   * at all, so the list rendered a lone "Agents" label over a single group,
   * captioning something that needed no caption. A badge says the same thing
   * where it is actually useful (on the row that differs) and disappears
   * entirely when every agent is the same kind.
   *
   * Selection is shown ONCE, by the check plus the tinted row. It used to be
   * said three times — check, tinted row, AND a heavier font weight on the
   * name — which made the selected row's title render at a different weight
   * from every other title for no added information.
   */
  const renderAgentItem = (agent: Agent, meta: boolean) => {
    const isSelected =
      selectedAgent === agent.name || (!selectedAgent && agent === primaryAgents[0]);
    return (
      <CommandItem
        key={agent.name}
        value={`agent-${agent.name}`}
        // `items-start` is what pins the check to the top right: the row is
        // two lines and a vertically-centred check floats between them,
        // pointing at neither.
        className={cn('items-start gap-2 py-2', isSelected && 'bg-primary/[0.06]')}
        onSelect={() => {
          onSelect(agent.name);
          setOpen(false);
        }}
      >
        {/* Every row leads with the agent's pixel mark, so the list is
            scanned by face before names are read. The tile matches the text
            block edge to edge: name (20px) plus description (16px) = 36px,
            or the name line alone. */}
        {agent.description ? (
          <AgentMark slug={agent.name} size={28} tile={36} />
        ) : (
          <AgentMark slug={agent.name} size={14} />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="text-foreground truncate text-sm font-medium">
              {label(agent.name)}
            </span>
            {meta && (
              <Badge variant="outline" size="xs" className="shrink-0 font-normal">
                {tHardcodedUi.raw('i18nComplete.textc78ffe195710')}
              </Badge>
            )}
          </div>
          {agent.description && (
            <p className="text-muted-foreground truncate text-xs">{agent.description}</p>
          )}
        </div>
        {isSelected && (
          // `mt-0.5` optically centres the 16px check against the first line
          // rather than the top edge of the text box.
          <CheckIcon className="text-foreground mt-0.5 size-4 shrink-0" />
        )}
      </CommandItem>
    );
  };

  /**
   * Nothing to pick from.
   *
   * The SAME trigger as the loaded state and as the model picker beside it —
   * same variant, size, radius, label slot and caret — just inert and muted.
   * It is deliberately not a wide pill, a banner, or an icon of its own: an
   * empty picker is still a picker, and the composer's bottom rail is a row of
   * sibling controls, not a place to put a notice. The reason lives in the
   * tooltip, and on the send button's tooltip, which is where a user who wants
   * it goes.
   *
   * The tooltip hangs off a `<span>` rather than the button: a disabled button
   * takes no pointer events, so a `Hint` wrapped straight around it would never
   * open — in exactly the state where its words matter.
   */
  if (primaryAgents.length === 0) {
    const trigger = field ? (
      fieldTrigger(false, { disabled: true, 'aria-label': unavailableHint ?? undefined })
    ) : (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled
        aria-label={unavailableHint ?? undefined}
        className="text-muted-foreground rounded-lg hit-area-y-3"
      >
        <span className={cn('max-w-[100px] truncate', triggerLabelClassName)}>{displayName}</span>
        <CaretDownIcon className="size-3" />
      </Button>
    );
    if (!unavailableHint) return trigger;
    return (
      <Hint side="top" label={unavailableHint}>
        <span className="inline-flex">{trigger}</span>
      </Hint>
    );
  }

  /**
   * An inert picker: this host offered the roster but the control is read-only
   * (a settings form the caller cannot write). The trigger stays — the agent
   * that would run must remain visible — but it stops pretending to be
   * interactive: no caret (the one cue that read as "opens a menu"), the muted
   * text every inert control on this rail wears, and the disabled attribute.
   */
  if (disabled) {
    if (field) return fieldTrigger(false, { disabled: true });
    return (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled
        className="text-muted-foreground rounded-lg hit-area-y-3"
      >
        {triggerMark}
        <span className={cn('max-w-[100px] truncate', triggerLabelClassName)}>{displayName}</span>
      </Button>
    );
  }

  return (
    <CommandPopover open={open} onOpenChange={setOpen}>
      <CommandPopoverTrigger>
        {field ? (
          fieldTrigger(true, { 'aria-label': t('selectAgent') })
        ) : (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={t('selectAgent')}
          className="text-foreground/70 rounded-lg hit-area-y-3"
        >
          {triggerMark}
          <span className={cn('max-w-[100px] truncate', triggerLabelClassName)}>{displayName}</span>
          <CaretDownIcon
            className={cn(
              'size-3 transition-transform duration-200 ease-out',
              open && 'rotate-180',
            )}
          />
        </Button>
        )}
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
        {/*
          A search field over four agents is a control that costs a row of
          chrome to save nobody any time — the whole list is already on screen
          and readable in one glance. It only earns its place once the list
          outgrows the popover and scanning turns into scrolling.

          It stays MOUNTED either way, just visually hidden, and that is
          deliberate: cmdk drives arrow-key navigation from a keydown handler
          on its own root, and the input is the only focusable descendant
          inside it. Unmounting it would leave focus on the Radix content
          wrapper — the parent — where keydown never reaches cmdk at all, so
          the arrow keys would silently stop working on exactly the short
          lists this is meant to simplify.
        */}
        <div className={showSearch ? undefined : 'sr-only'}>
          <CommandInput
            compact
            placeholder={tHardcodedUi.raw(
              'componentsSessionSessionChatInput.line231JsxAttrPlaceholderSearchAgents',
            )}
            value={search}
            onValueChange={setSearch}
          />
        </div>

        <CommandList className="max-h-[320px]">
          {/*
            ONE group, no heading — and the group is not optional dressing.
            `CommandPopoverContent` forces `[data-slot=command-list]:py-0` and
            gives `[data-slot=command-group]` its `py-1`, so the GROUP is what
            carries this popover's vertical inset. Dropping it (and padding the
            list instead) loses that fight on specificity — a descendant
            selector beats a plain class — and the rows end up flush against
            the popover's top and bottom edges.

            The heading is what goes, not the group. The row's own badge
            carries the type, so a heading would repeat it — and with no meta
            agents (the common case) it captioned a single group with a lone
            "Agents" label that told the reader nothing they could not see.
            Meta agents are ordered first, so the grouping still reads without
            being announced.
          */}
          {filteredPrimary.length > 0 && (
            // `gap-px` between rows: a selected row and a hovered row next to it
            // otherwise draw one merged grey block.
            <CommandGroup
              forceMount
              className="[&_[cmdk-group-items]]:flex [&_[cmdk-group-items]]:flex-col [&_[cmdk-group-items]]:gap-px"
            >
              {filteredMeta.map((agent) => renderAgentItem(agent, true))}
              {filteredMeta.length > 0 && filteredProject.length > 0 && (
                <CommandSeparator className="my-1" />
              )}
              {filteredProject.map((agent) => renderAgentItem(agent, false))}
            </CommandGroup>
          )}

          {/* No results */}
          {filteredPrimary.length === 0 && search.trim() && (
            <div className="text-muted-foreground/50 py-8 text-center text-xs">
              {tHardcodedUi.raw(
                'componentsSessionSessionChatInput.line273JsxTextNoAgentsMatchLdquo',
              )}
              {search.trim()}
              {tHardcodedUi.raw('componentsSessionSessionChatInput.line273JsxTextRdquo')}
            </div>
          )}
        </CommandList>
      </CommandPopoverContent>
    </CommandPopover>
  );
}
