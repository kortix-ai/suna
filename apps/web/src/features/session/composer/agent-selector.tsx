'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandPopover,
  CommandPopoverContent,
  CommandPopoverTrigger,
} from '@/components/ui/command';
import { cn } from '@/lib/utils';
import type { Agent } from '@kortix/sdk/react';
import { isMetaAgentName } from '@kortix/shared';
import { CaretDownIcon, CheckIcon, FolderSimpleIcon as MetaFolder } from '@phosphor-icons/react';
import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useState } from 'react';

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

export function AgentSelector({
  agents,
  selectedAgent,
  onSelect,
  disabled = false,
  triggerLabelClassName,
}: {
  agents: Agent[];
  selectedAgent: string | null;
  onSelect: (agentName: string | null) => void;
  disabled?: boolean;
  triggerLabelClassName?: string;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');

  const primaryAgents = useMemo(
    () => agents.filter((a) => !a.hidden && a.mode !== 'subagent'),
    [agents],
  );

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
      (a) => a.name.toLowerCase().includes(q) || (a.description || '').toLowerCase().includes(q),
    );
  }, [primaryAgents, search]);

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

  const currentAgent = primaryAgents.find((a) => a.name === selectedAgent) || primaryAgents[0];
  const displayName = currentAgent?.name || 'Agent';
  const metaSelected = isMetaAgentName(currentAgent?.name);

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
          if (disabled) return;
          onSelect(agent.name);
          setOpen(false);
        }}
      >
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="text-foreground truncate text-sm font-medium capitalize">
              {agent.name}
            </span>
            {meta && (
              <Badge variant="outline" size="xs" className="shrink-0 font-normal">
                Platform
              </Badge>
            )}
          </div>
          {agent.description && (
            <p className="text-muted-foreground mt-0.5 truncate text-xs">{agent.description}</p>
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

  return (
    <CommandPopover open={open} onOpenChange={(next) => setOpen(disabled ? false : next)}>
      <CommandPopoverTrigger>
        <Button type="button" variant="ghost" size="sm" className="text-foreground/70 rounded-lg">
          {metaSelected && <MetaFolder className="size-3.5 shrink-0" weight="fill" />}
          <span className={cn('max-w-[100px] truncate', triggerLabelClassName)}>{displayName}</span>
          <CaretDownIcon className={cn('size-3', open && 'rotate-180')} />
        </Button>
      </CommandPopoverTrigger>

      <CommandPopoverContent side="top" align="start" sideOffset={8} className="w-[300px] ">
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
            <CommandGroup forceMount>
              {filteredMeta.map((agent) => renderAgentItem(agent, true))}
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
