'use client';

import { useTranslations } from 'next-intl';

import {
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandItemHoverCard,
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

import { Check, ChevronDown } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { isHarnessDisconnected } from './agent-selector-helpers';
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

/** Claude Code, Codex, and Pi surface exactly one agent — the harness itself —
 *  so those rows read as the brand ("Claude Code"), while OpenCode's many
 *  named agents read as themselves ("kortix", "build", …). */
const BRAND_ROW_HARNESSES: ReadonlySet<KortixHarness> = new Set(['claude', 'codex', 'pi']);

/** Single-agent brand harnesses first, then OpenCode's agents, then agents
 *  with no resolvable harness. Stable within each harness. */
const HARNESS_ROW_ORDER: ReadonlyArray<KortixHarness | 'other'> = [
  'claude',
  'codex',
  'pi',
  'opencode',
  'other',
];

function HarnessIcon({ harness, className }: { harness: KortixHarness; className?: string }) {
  return (
    <ProviderLogo
      providerID={HARNESS_ICON_PROVIDER_ID[harness]}
      size="large"
      className={cn('size-4 rounded-none bg-transparent dark:bg-transparent', className)}
    />
  );
}

function agentDisplayName(agent: Agent | undefined): string {
  if (!agent) return 'Agent';
  const harness = agentHarness(agent);
  return harness && BRAND_ROW_HARNESSES.has(harness)
    ? harnessPresentation(harness).label
    : agent.name;
}

/** What the row's hover card explains: the harness blurb for brand rows
 *  (Claude Code, Codex, Pi), the agent's own manifest description for
 *  OpenCode/other agents. `null` → no card, the row renders bare. */
function agentHoverDescription(agent: Agent): string | null {
  const harness = agentHarness(agent);
  if (harness && BRAND_ROW_HARNESSES.has(harness)) return harnessPresentation(harness).description;
  return agent.description?.trim() || null;
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

  // Match what the user can actually see: the row's display name (brand label
  // for Claude Code/Codex/Pi, agent name for OpenCode) plus the raw name.
  const filteredPrimary = useMemo(() => {
    const q = search.toLowerCase().trim();
    if (!q) return primaryAgents;
    return primaryAgents.filter(
      (a) => a.name.toLowerCase().includes(q) || agentDisplayName(a).toLowerCase().includes(q),
    );
  }, [primaryAgents, search]);

  // One flat list, every row the same anatomy: logo + name. No group
  // headings, no per-row descriptions — the logo already says which harness
  // a row belongs to, and identical rows are the easiest thing to scan.
  const orderedAgents = useMemo(() => {
    const rank = new Map(HARNESS_ROW_ORDER.map((harness, index) => [harness, index]));
    return [...filteredPrimary].sort(
      (a, b) =>
        (rank.get(agentHarness(a) ?? 'other') ?? HARNESS_ROW_ORDER.length) -
        (rank.get(agentHarness(b) ?? 'other') ?? HARNESS_ROW_ORDER.length),
    );
  }, [filteredPrimary]);

  const currentAgent = primaryAgents.find((a) => a.name === selectedAgent) || primaryAgents[0];
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
            {currentHarness ? <HarnessIcon harness={currentHarness.id} /> : null}
            <span className="max-w-[96px] truncate capitalize sm:max-w-[130px]">
              {agentDisplayName(currentAgent)}
            </span>
            {/* Locked state drops the chevron too — per the pill law's
                "chevron ⇔ popover" rule (composer-pill.ts): the popover
                genuinely doesn't open while locked, so a trailing glyph here
                would promise an interaction that isn't available. The lock
                icon itself is gone (2026-07-22 decree — "the lock just looks
                ass"); the locked semantics live ONLY in the wrapping `Hint`'s
                hover tooltip above, never a glyph on the trigger. */}
            {disabled ? null : (
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

      <CommandPopoverContent side="top" align="start" sideOffset={8} className="w-[260px]">
        <CommandInput
          compact
          placeholder={tHardcodedUi.raw(
            'componentsSessionSessionChatInput.line231JsxAttrPlaceholderSearchAgents',
          )}
          value={search}
          onValueChange={setSearch}
        />

        <CommandList className="max-h-[320px]">
          <CommandGroup forceMount>
            {orderedAgents.map((agent) => {
              const isSelected =
                selectedAgent === agent.name || (!selectedAgent && agent === primaryAgents[0]);
              const presentation = agentHarnessPresentation(agent);
              const isDisconnected = isHarnessDisconnected(
                presentation ? runtimeStatusByHarness.get(presentation.id) : undefined,
              );
              const description = agentHoverDescription(agent);
              return (
                <CommandItemHoverCard
                  key={agent.name}
                  content={
                    description ? (
                      <div data-testid="agent-hover-card">
                        <p
                          className={cn(
                            'text-sm font-medium',
                            (!presentation || !BRAND_ROW_HARNESSES.has(presentation.id)) &&
                              'capitalize',
                          )}
                        >
                          {agentDisplayName(agent)}
                        </p>
                        <p className="text-muted-foreground mt-1 text-xs leading-snug text-pretty">
                          {description}
                        </p>
                      </div>
                    ) : null
                  }
                >
                  <CommandItem
                    value={`agent-${agent.name}`}
                    data-testid="agent-option"
                    data-agent={agent.name}
                    data-harness={presentation?.id ?? 'unknown'}
                    className={cn('gap-2 py-2', isSelected && 'bg-primary/[0.06]')}
                    onSelect={() => {
                      if (disabled) return;
                      onSelect(agent.name);
                      setOpen(false);
                    }}
                  >
                    {presentation ? (
                      <HarnessIcon harness={presentation.id} className="size-4 shrink-0" />
                    ) : (
                      <span aria-hidden className="size-4 shrink-0" />
                    )}
                    <span
                      className={cn(
                        'min-w-0 flex-1 truncate text-sm leading-tight',
                        (!presentation || !BRAND_ROW_HARNESSES.has(presentation.id)) &&
                          'capitalize',
                        isSelected
                          ? 'text-foreground font-semibold'
                          : 'text-foreground/90 font-medium',
                      )}
                    >
                      {agentDisplayName(agent)}
                    </span>
                    {isDisconnected && (
                      <Hint label="No model connected" side="right" className="text-xs">
                        <span
                          data-testid="agent-connection-dot"
                          className="bg-kortix-orange size-1.5 shrink-0 rounded-full"
                        />
                      </Hint>
                    )}
                    {isSelected && <Check className="text-foreground size-4 shrink-0" />}
                  </CommandItem>
                </CommandItemHoverCard>
              );
            })}
          </CommandGroup>

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
