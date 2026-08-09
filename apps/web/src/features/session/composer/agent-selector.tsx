'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useRef, useState } from 'react';

import {
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandPopover,
  CommandPopoverContent,
  CommandPopoverTrigger,
} from '@/components/ui/command';
import Hint from '@/components/ui/hint';
import { cn } from '@/lib/utils';
import type { Agent } from '@kortix/sdk/react';
import { isAgiAgentName } from '@kortix/shared';
import { CaretDownIcon, Check, FolderSimpleIcon as AgiFolder } from '@phosphor-icons/react';

// ============================================================================
// Agent Selector
// ============================================================================

export function AgentSelector({
  agents,
  selectedAgent,
  onSelect,
  disabled = false,
}: {
  agents: Agent[];
  selectedAgent: string | null;
  onSelect: (agentName: string | null) => void;
  disabled?: boolean;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [flash, setFlash] = useState(false);
  const prevAgentRef = useRef(selectedAgent);

  const primaryAgents = useMemo(
    () => agents.filter((a) => !a.hidden && a.mode !== 'subagent'),
    [agents],
  );

  // Flash highlight when agent changes (e.g. via Tab cycling)
  useEffect(() => {
    if (prevAgentRef.current !== selectedAgent && prevAgentRef.current !== null) {
      setFlash(true);
      const timer = setTimeout(() => setFlash(false), 400);
      return () => clearTimeout(timer);
    }
    prevAgentRef.current = selectedAgent;
  }, [selectedAgent]);

  useEffect(() => {
    prevAgentRef.current = selectedAgent;
  }, [selectedAgent]);

  // Reset search when closing
  useEffect(() => {
    if (!open) setSearch('');
  }, [open]);

  // Fuzzy filter
  const filteredPrimary = useMemo(() => {
    const q = search.toLowerCase().trim();
    if (!q) return primaryAgents;
    return primaryAgents.filter(
      (a) => a.name.toLowerCase().includes(q) || (a.description || '').toLowerCase().includes(q),
    );
  }, [primaryAgents, search]);

  // The platform coordinator is not a project agent — it renders in its own
  // group so the split between platform-owned and repo-declared agents is
  // visible at a glance.
  const filteredAgi = useMemo(
    () => filteredPrimary.filter((a) => isAgiAgentName(a.name)),
    [filteredPrimary],
  );
  const filteredProject = useMemo(
    () => filteredPrimary.filter((a) => !isAgiAgentName(a.name)),
    [filteredPrimary],
  );

  const currentAgent = primaryAgents.find((a) => a.name === selectedAgent) || primaryAgents[0];
  const displayName = currentAgent?.name || 'Agent';
  const agiSelected = isAgiAgentName(currentAgent?.name);

  const renderAgentItem = (agent: Agent, agi: boolean) => {
    const isSelected =
      selectedAgent === agent.name || (!selectedAgent && agent === primaryAgents[0]);
    return (
      <CommandItem
        key={agent.name}
        value={`agent-${agent.name}`}
        className={isSelected ? 'bg-foreground/[0.06]' : undefined}
        onSelect={() => {
          if (disabled) return;
          onSelect(agent.name);
          setOpen(false);
        }}
      >
        {agi && (
          <span className="text-muted-foreground/80 flex size-4 shrink-0 items-center justify-center self-start pt-1">
            <AgiFolder className="size-3.5" weight="fill" />
          </span>
        )}
        <div className="min-w-0 flex-1 py-0.5">
          <div
            className={cn(
              'truncate text-sm leading-tight capitalize',
              isSelected ? 'text-foreground font-semibold' : 'text-foreground/90 font-medium',
            )}
          >
            {agent.name}
          </div>
          {agent.description && (
            <p className="text-muted-foreground/55 mt-1 truncate text-xs leading-snug">
              {agent.description}
            </p>
          )}
        </div>
        {isSelected && <Check className="text-foreground shrink-0" />}
      </CommandItem>
    );
  };

  return (
    // When locked we keep the trigger hoverable (no native `disabled`, which
    // would suppress hover) but gate the popover shut, so the tooltip can still
    // explain WHY the agent can't be switched mid-session.
    <CommandPopover open={open} onOpenChange={(next) => setOpen(disabled ? false : next)}>
      <Hint
        side="top"
        className="max-w-[240px]"
        label={
          disabled ? (
            <p>
              {
                "This agent is set when the session starts and can't be changed here. Start a new session to use a different agent."
              }
            </p>
          ) : (
            <p>
              {tHardcodedUi.raw('componentsSessionSessionChatInput.line224JsxTextSwitchAgent')}
              <kbd className="bg-foreground/10 ml-1 rounded px-1.5 py-0.5 font-mono text-xs">
                Tab
              </kbd>
            </p>
          )
        }
      >
        <CommandPopoverTrigger>
          <button
            type="button"
            aria-disabled={disabled || undefined}
            aria-label={tHardcodedUi.raw(
              'componentsSessionSessionChatInput.line211JsxAttrAriaLabelAgentPicker',
            )}
            className={cn(
              'text-muted-foreground hover:text-foreground hover:bg-muted inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full px-2.5 text-xs font-medium capitalize transition-[color,background-color,transform] duration-200 active:scale-[0.96]',
              flash && 'bg-primary/10 text-foreground',
              open && 'bg-muted text-foreground',
              disabled &&
                'hover:text-muted-foreground cursor-not-allowed opacity-70 hover:bg-transparent',
            )}
          >
            {agiSelected && <AgiFolder className="size-3.5 shrink-0" weight="fill" />}
            <span className="max-w-[100px] truncate">{displayName}</span>
            <CaretDownIcon
              className={cn(
                'size-3 opacity-50 transition-transform duration-200',
                open && 'rotate-180',
              )}
            />
          </button>
        </CommandPopoverTrigger>
      </Hint>

      <CommandPopoverContent side="top" align="start" sideOffset={8} className="w-[300px]">
        <CommandInput
          compact
          placeholder={tHardcodedUi.raw(
            'componentsSessionSessionChatInput.line231JsxAttrPlaceholderSearchAgents',
          )}
          value={search}
          onValueChange={setSearch}
        />

        <CommandList className="max-h-[320px]">
          {/* Platform coordinator — separated from the project's own agents. */}
          {filteredAgi.length > 0 && (
            <CommandGroup heading="Platform" forceMount>
              {filteredAgi.map((agent) => renderAgentItem(agent, true))}
            </CommandGroup>
          )}

          {/* Project agents */}
          {filteredProject.length > 0 && (
            <CommandGroup heading="Agents" forceMount>
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
