'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useRef, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import {
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandPopover,
  CommandPopoverContent,
  CommandPopoverTrigger,
} from '@/components/ui/command';
import { KortixLogo } from '@/components/ui/kortix-logo';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { Agent } from '@kortix/sdk/react';
import { Check, ChevronDown } from 'lucide-react';

import { platformAgentCopy, splitPlatformAgents } from '../platform-agents';

// ============================================================================
// Agent Selector
// ============================================================================

/** Stable identity so the default prop never re-triggers downstream memos. */
export const EMPTY_PLATFORM_AGENT_NAMES: readonly string[] = [];

export function AgentSelector({
  agents,
  selectedAgent,
  onSelect,
  disabled = false,
  platformAgentNames = EMPTY_PLATFORM_AGENT_NAMES,
}: {
  agents: Agent[];
  selectedAgent: string | null;
  onSelect: (agentName: string | null) => void;
  disabled?: boolean;
  /** Names of the platform-owned agents in `agents` (see ../platform-agents).
   *  Those render elevated above the workspace's own agents. Empty — the
   *  default, and what every project without the `agi` flag produces — renders
   *  the picker exactly as it did before platform agents existed. */
  platformAgentNames?: readonly string[];
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

  // The elevated block is carved out of the SAME filtered list the rows come
  // from, so search still reaches it and `primaryAgents[0]` keeps identifying
  // the implicitly-selected agent exactly as before.
  const { platform: platformFiltered, workspace: workspaceFiltered } = useMemo(
    () => splitPlatformAgents(filteredPrimary, platformAgentNames),
    [filteredPrimary, platformAgentNames],
  );
  const hasPlatformAgents = platformFiltered.length > 0;

  const currentAgent = primaryAgents.find((a) => a.name === selectedAgent) || primaryAgents[0];
  const currentIsPlatform = !!currentAgent && platformAgentNames.includes(currentAgent.name);
  const displayName = currentAgent
    ? currentIsPlatform
      ? platformAgentCopy(currentAgent).title
      : currentAgent.name
    : 'Agent';

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
              {currentIsPlatform && (
                <KortixLogo variant="icon" size={12} className="shrink-0" aria-hidden />
              )}
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

      <CommandPopoverContent
        side="top"
        align="start"
        sideOffset={8}
        // The elevated card carries a full, wrapped description; 300px would
        // squeeze it into a wall of five lines.
        className={hasPlatformAgents ? 'w-[344px]' : 'w-[300px]'}
      >
        <CommandInput
          compact
          placeholder={tHardcodedUi.raw(
            'componentsSessionSessionChatInput.line231JsxAttrPlaceholderSearchAgents',
          )}
          value={search}
          onValueChange={setSearch}
        />

        <CommandList className={hasPlatformAgents ? 'max-h-[380px]' : 'max-h-[320px]'}>
          {/* Platform-owned agents — the control agents the product wants you
              talking to. Rendered as cards above the workspace's own roster,
              not as another row in it (R-37). Selection only: a platform-owned
              agent is never offered edit/scope/delete here. */}
          {hasPlatformAgents && (
            <CommandGroup className="pb-0" forceMount>
              {platformFiltered.map((agent) => {
                const isSelected =
                  selectedAgent === agent.name || (!selectedAgent && agent === primaryAgents[0]);
                const copy = platformAgentCopy(agent);
                return (
                  <CommandItem
                    key={agent.name}
                    value={`agent-${agent.name}`}
                    className={cn(
                      // rounded-sm is concentric with the popover's rounded-lg
                      // minus the group's 4px inset.
                      'items-start gap-3 rounded-sm border px-3 py-3 transition-colors duration-150',
                      isSelected ? 'bg-primary/[0.08]' : 'bg-primary/[0.05]',
                    )}
                    onSelect={() => {
                      if (disabled) return;
                      onSelect(agent.name);
                      setOpen(false);
                    }}
                  >
                    <span className="bg-kortix-base/20 flex size-8 shrink-0 items-center justify-center rounded-sm">
                      <KortixLogo
                        variant="icon"
                        size={15}
                        className="text-foreground"
                        aria-hidden
                      />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="text-foreground truncate text-sm leading-tight font-semibold">
                          {copy.title}
                        </span>
                        <Badge variant="kortix" size="xs" className="shrink-0">
                          Kortix
                        </Badge>
                      </div>
                      {copy.description && (
                        <p className="text-muted-foreground mt-1.5 text-xs leading-relaxed text-pretty">
                          {copy.description}
                        </p>
                      )}
                    </div>
                    {isSelected && <Check className="text-foreground mt-0.5 shrink-0" />}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          )}

          {/* Workspace agents */}
          {workspaceFiltered.length > 0 && (
            <CommandGroup heading={hasPlatformAgents ? 'Workspace agents' : 'Agents'} forceMount>
              {workspaceFiltered.map((agent) => {
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
