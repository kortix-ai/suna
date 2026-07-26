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
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { Agent } from '@kortix/sdk/react';
import { Check, ChevronDown } from 'lucide-react';

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

  const currentAgent = primaryAgents.find((a) => a.name === selectedAgent) || primaryAgents[0];
  const displayName = currentAgent?.name || 'Agent';

  return (
    // When locked we keep the trigger hoverable (no native `disabled`, which
    // would suppress hover) but gate the popover shut, so the tooltip can still
    // explain WHY the agent can't be switched mid-session.
    <CommandPopover open={open} onOpenChange={(next) => setOpen(disabled ? false : next)}>
      <Tooltip>
        <TooltipTrigger asChild>
          <CommandPopoverTrigger>
            <button
              type="button"
              aria-disabled={disabled || undefined}
              aria-label={tHardcodedUi.raw(
                'componentsSessionSessionChatInput.line211JsxAttrAriaLabelAgentPicker',
              )}
              className={cn(
                'text-muted-foreground hover:text-foreground hover:bg-muted inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full px-2.5 text-xs font-medium capitalize transition-colors duration-200',
                flash && 'bg-primary/10 text-foreground',
                open && 'bg-muted text-foreground',
                disabled &&
                  'hover:text-muted-foreground cursor-not-allowed opacity-70 hover:bg-transparent',
              )}
            >
              <span className="max-w-[100px] truncate">{displayName}</span>
              <ChevronDown
                className={cn(
                  'size-3 opacity-50 transition-transform duration-200',
                  open && 'rotate-180',
                )}
              />
            </button>
          </CommandPopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-[240px]">
          {disabled ? (
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
          )}
        </TooltipContent>
      </Tooltip>

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
          {/* Primary agents */}
          {filteredPrimary.length > 0 && (
            <CommandGroup heading="Agents" forceMount>
              {filteredPrimary.map((agent) => {
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
                    <div className="min-w-0 flex-1 py-0.5">
                      <div
                        className={cn(
                          'truncate text-sm leading-tight capitalize',
                          isSelected
                            ? 'text-foreground font-semibold'
                            : 'text-foreground/90 font-medium',
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
              })}
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
