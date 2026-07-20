'use client';

import { useTranslations } from 'next-intl';

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
import Hint from '@/components/ui/hint';
import { ProviderLogo } from '@/features/providers/provider-branding';
import type { Agent } from '@/hooks/runtime/use-runtime-sessions';
import { cn } from '@/lib/utils';
import {
  agentHarness,
  agentHarnessPresentation,
  harnessPresentation,
  type KortixHarness,
  type ModelsPageRuntimeStatus,
  useModelsPage,
} from '@kortix/sdk/react';

import { Check, ChevronDown, Lock } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AGENT_GROUP_ORDER,
  isHarnessDisconnected,
  shouldGroupAgentsByHarness,
} from './agent-selector-helpers';
import {
  COMPOSER_PILL_ACTIVE_CLASS,
  COMPOSER_PILL_DISABLED_CLASS,
  COMPOSER_PILL_TRIGGER_CLASS,
} from './composer-pill';

// ============================================================================
// Agent Selector
// ============================================================================

/** Small inline harness icon — a brand mark, not a status tile, so it drops
 *  the tinted background and shrinks to fit a text-xs row/pill. */
const HARNESS_ICON_PROVIDER_ID: Record<KortixHarness, string> = {
  claude: 'anthropic',
  codex: 'codex',
  opencode: 'opencode',
  pi: 'pi',
};

function HarnessIcon({ harness, className }: { harness: KortixHarness; className?: string }) {
  return (
    <ProviderLogo
      providerID={HARNESS_ICON_PROVIDER_ID[harness]}
      size="small"
      className={cn('size-3.5 rounded-none bg-transparent dark:bg-transparent', className)}
    />
  );
}

export function AgentSelector({
  agents,
  selectedAgent,
  onSelect,
  disabled = false,
  projectId,
}: {
  agents: Agent[];
  selectedAgent: string | null;
  onSelect: (agentName: string | null) => void;
  disabled?: boolean;
  /** Lets the picker read this project's per-harness connection status
   *  (`useModelsPage(projectId).runtimes`) to drive the row-level "no model
   *  connected" dot. Omitted → no runtime data → no dots, never a false
   *  "disconnected" reading. */
  projectId?: string;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [flash, setFlash] = useState(false);
  const prevAgentRef = useRef(selectedAgent);

  const { runtimes } = useModelsPage(projectId);
  const runtimeStatusByHarness = useMemo(() => {
    const map = new Map<KortixHarness, ModelsPageRuntimeStatus>();
    for (const runtime of runtimes) map.set(runtime.harness, runtime.status);
    return map;
  }, [runtimes]);

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
    return primaryAgents.filter((a) => {
      const presentation = agentHarnessPresentation(a);
      return (
        a.name.toLowerCase().includes(q) ||
        (a.description || '').toLowerCase().includes(q) ||
        (presentation?.label || '').toLowerCase().includes(q)
      );
    });
  }, [primaryAgents, search]);

  // Group headers only earn their place once agents actually span more than
  // one harness — the common single-harness project gets a flat list.
  const shouldGroup = useMemo(
    () => shouldGroupAgentsByHarness(primaryAgents.map((a) => agentHarness(a))),
    [primaryAgents],
  );

  const groupedAgents = useMemo(() => {
    if (!shouldGroup) return [{ harness: 'flat' as const, agents: filteredPrimary }];
    const groups = new Map<KortixHarness | 'other', Agent[]>();
    for (const agent of filteredPrimary) {
      const key = agentHarness(agent) ?? 'other';
      groups.set(key, [...(groups.get(key) ?? []), agent]);
    }
    const order: ReadonlyArray<KortixHarness | 'other'> = AGENT_GROUP_ORDER;
    return order
      .map((harness) => ({ harness, agents: groups.get(harness) ?? [] }))
      .filter((group) => group.agents.length > 0);
  }, [filteredPrimary, shouldGroup]);

  const currentAgent = primaryAgents.find((a) => a.name === selectedAgent) || primaryAgents[0];
  const displayName = currentAgent?.name || 'Agent';
  const currentHarness = agentHarnessPresentation(currentAgent);

  return (
    // When locked we keep the trigger hoverable (no native `disabled`, which
    // would suppress hover) but gate the popover shut, so the tooltip can still
    // explain WHY the agent can't be switched mid-session.
    <CommandPopover open={open} onOpenChange={(next) => setOpen(disabled ? false : next)}>
      <Hint
        side="top"
        className="max-w-[260px] text-xs"
        label={
          disabled ? (
            'Agent is fixed for this session — start a new session to switch'
          ) : (
            <span className="flex items-center gap-1">
              {tHardcodedUi.raw('componentsSessionSessionChatInput.line224JsxTextSwitchAgent')}
              <kbd className="bg-foreground/10 rounded px-1.5 py-0.5 font-mono text-xs">Tab</kbd>
            </span>
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
            data-testid="agent-selector"
            data-harness={currentHarness?.id ?? 'unknown'}
            className={cn(
              COMPOSER_PILL_TRIGGER_CLASS,
              flash && COMPOSER_PILL_ACTIVE_CLASS,
              open && COMPOSER_PILL_ACTIVE_CLASS,
              disabled && COMPOSER_PILL_DISABLED_CLASS,
            )}
          >
            <span className="max-w-[72px] truncate capitalize sm:max-w-[100px]">{displayName}</span>
            {currentHarness ? <HarnessIcon harness={currentHarness.id} /> : null}
            {disabled ? (
              <Lock className="size-3 shrink-0 opacity-60" />
            ) : (
              <ChevronDown
                className={cn(
                  'size-3 opacity-50 transition-transform duration-200',
                  open && 'rotate-180',
                )}
              />
            )}
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
          {groupedAgents.map((group) => {
            const groupPresentation =
              shouldGroup && group.harness !== 'other' && group.harness !== 'flat'
                ? harnessPresentation(group.harness)
                : null;
            return (
              <CommandGroup
                key={group.harness}
                heading={
                  shouldGroup ? (
                    <div
                      data-testid="agent-group-heading"
                      className="flex items-center justify-between gap-2"
                    >
                      <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
                        {groupPresentation ? (
                          <HarnessIcon harness={groupPresentation.id} />
                        ) : null}
                        {groupPresentation?.label ?? 'Other agents'}
                      </span>
                      <span className="text-muted-foreground/50 text-xs tabular-nums">
                        {group.agents.length}
                      </span>
                    </div>
                  ) : undefined
                }
                forceMount
              >
                {group.agents.map((agent) => {
                  const isSelected =
                    selectedAgent === agent.name || (!selectedAgent && agent === primaryAgents[0]);
                  const presentation = agentHarnessPresentation(agent);
                  const isDisconnected = isHarnessDisconnected(
                    presentation ? runtimeStatusByHarness.get(presentation.id) : undefined,
                  );
                  return (
                    <CommandItem
                      key={agent.name}
                      value={`agent-${agent.name}`}
                      data-testid="agent-option"
                      data-agent={agent.name}
                      data-harness={presentation?.id ?? 'unknown'}
                      className={isSelected ? 'bg-primary/[0.06]' : undefined}
                      onSelect={() => {
                        if (disabled) return;
                        onSelect(agent.name);
                        setOpen(false);
                      }}
                    >
                      <div className="min-w-0 flex-1 py-0.5">
                        <div className="flex min-w-0 items-center gap-1.5">
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
                          {presentation ? (
                            <Badge variant="outline" size="xs" className="shrink-0 gap-1 pl-1">
                              <HarnessIcon harness={presentation.id} className="size-3" />
                              {presentation.shortLabel}
                            </Badge>
                          ) : null}
                        </div>
                        {agent.description && (
                          <p className="text-muted-foreground/55 mt-1 truncate text-xs leading-snug">
                            {agent.description}
                          </p>
                        )}
                      </div>
                      {isDisconnected && (
                        <Hint label="No model connected" side="right" className="text-xs">
                          <span
                            data-testid="agent-connection-dot"
                            className="bg-kortix-orange size-1.5 shrink-0 rounded-full"
                          />
                        </Hint>
                      )}
                      {isSelected && <Check className="text-foreground shrink-0" />}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            );
          })}

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
