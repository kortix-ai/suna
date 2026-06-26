'use client';

import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { ProgressRing } from '@/components/ui/progress-ring';
import { STATUS_TEXT } from '@/components/ui/status';
import { normalizeAppPathname } from '@/lib/instance-routes';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import {
  ArrowUp,
  ArrowUpLeft,
  Check,
  ChevronDown,
  Folder,
  ListTodo,
  // Info,       // AutoContinue — commented out
  // Infinity,   // AutoContinue — commented out
  Loader2,
  MessageSquare,
  Paperclip,
  Reply,
  Terminal,
  X,
} from 'lucide-react';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
/* AutoContinue — commented out
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
*/
import { VoiceRecorder } from '@/components/thread/chat-input/voice-recorder';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { searchWorkspaceFiles } from '@/features/files';
import { getFileIcon } from '@/features/files/components/file-icon';
import type {
  Agent,
  Command,
  MessageWithParts,
  PromptPart,
  ProviderListResponse,
  Session,
} from '@/hooks/opencode/use-opencode-sessions';
import {
  GATEWAY_PROVIDER_IDS,
  useOpenCodeSessions,
  useOpenCodeSessionTodo,
} from '@/hooks/opencode/use-opencode-sessions';
import { AnimatePresence, motion } from 'motion/react';
import { extractClipboardFiles } from './clipboard-files';
import { ModelSelector } from './model-selector';

import {
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandPopover,
  CommandPopoverContent,
  CommandPopoverTrigger,
} from '@/components/ui/command';

export type { ProviderListResponse };

function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return `${Math.floor(days / 7)}w ago`;
}

// ============================================================================
// Flat model list helper
// ============================================================================

export interface FlatModel {
  providerID: string;
  providerName: string;
  modelID: string;
  modelName: string;
  variants?: Record<string, Record<string, unknown>>;
  /** Capabilities extracted from the provider API response */
  capabilities?: {
    reasoning?: boolean;
    vision?: boolean;
    toolcall?: boolean;
  };
  /** Context window size in tokens */
  contextWindow?: number;
  /** ISO date string for release date */
  releaseDate?: string;
  /** Model family (used for "latest" logic) */
  family?: string;
  /** Cost per token (input/output) */
  cost?: {
    input: number;
    output: number;
  };
  /** Provider source (env, api, config, custom) */
  providerSource?: string;
}

export function flattenModels(providers: ProviderListResponse | undefined): FlatModel[] {
  if (!providers) return [];
  const all = Array.isArray(providers.all) ? providers.all : [];
  const connected = Array.isArray(providers.connected) ? providers.connected : [];
  const result: FlatModel[] = [];
  for (const p of all) {
    if (!connected.includes(p.id)) continue;
    // Defense in depth: the provider list is already source-filtered to the
    // gateway, but never render a native (bypass) provider even if one slips in.
    if (!GATEWAY_PROVIDER_IDS.has(p.id)) continue;
    for (const [modelID, model] of Object.entries(p.models)) {
      const caps = (model as any).capabilities;
      const modalities = (model as any).modalities;
      result.push({
        providerID: p.id,
        providerName: p.name,
        modelID,
        modelName: (model.name || modelID).replace('(latest)', '').trim(),
        variants: model.variants,
        capabilities: caps
          ? {
              reasoning: caps.reasoning ?? false,
              vision: caps.input?.image ?? false,
              toolcall: caps.toolcall ?? false,
            }
          : {
              reasoning: (model as any).reasoning ?? false,
              vision: modalities?.input?.includes('image') ?? false,
              toolcall: (model as any).tool_call ?? false,
            },
        contextWindow: (model as any).limit?.context,
        releaseDate: (model as any).release_date,
        family: (model as any).family,
        cost: (model as any).cost
          ? {
              input: (model as any).cost.input ?? 0,
              output: (model as any).cost.output ?? 0,
            }
          : undefined,
        providerSource: (p as any).source,
      });
    }
  }
  return result;
}

// ============================================================================
// Agent Selector
// ============================================================================

export function AgentSelector({
  agents,
  selectedAgent,
  onSelect,
}: {
  agents: Agent[];
  selectedAgent: string | null;
  onSelect: (agentName: string | null) => void;
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
    <CommandPopover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <CommandPopoverTrigger>
            <button
              type="button"
              aria-label={tHardcodedUi.raw(
                'componentsSessionSessionChatInput.line211JsxAttrAriaLabelAgentPicker',
              )}
              className={cn(
                'text-muted-foreground hover:text-foreground hover:bg-muted inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full px-2.5 text-xs font-medium capitalize transition-colors duration-200',
                flash && 'bg-primary/10 text-foreground',
                open && 'bg-muted text-foreground',
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
        <TooltipContent side="top" className="text-xs">
          <p>
            {tHardcodedUi.raw('componentsSessionSessionChatInput.line224JsxTextSwitchAgent')}
            <kbd className="bg-foreground/10 ml-1 rounded px-1.5 py-0.5 font-mono text-xs">Tab</kbd>
          </p>
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

// ModelSelector is now a standalone component: ./model-selector.tsx

// ============================================================================
// Variant / Thinking Mode Selector
// ============================================================================

function VariantSelector({
  variants,
  selectedVariant,
  onSelect,
}: {
  variants: string[];
  selectedVariant: string | null;
  onSelect: (variant: string | null) => void;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const currentIndex = selectedVariant ? variants.indexOf(selectedVariant) : -1;

  function cycle() {
    if (variants.length === 0) return;
    const nextIndex = (currentIndex + 1) % (variants.length + 1);
    onSelect(nextIndex === variants.length ? null : variants[nextIndex]);
  }

  const displayName = selectedVariant || 'Default';

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={cycle}
          className={cn(
            'text-muted-foreground hover:text-foreground hover:bg-muted inline-flex h-8 cursor-pointer items-center gap-1 rounded-full px-2.5 text-xs font-medium capitalize transition-colors',
            selectedVariant && 'text-foreground',
          )}
        >
          {displayName}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">
        <p className="text-xs">
          {tHardcodedUi.raw('componentsSessionSessionChatInput.line322JsxTextCycleThinkingEffort')}
        </p>
      </TooltipContent>
    </Tooltip>
  );
}

/* AutoContinue — commented out
// ============================================================================
// AutoContinue Mode Selector
// ============================================================================

export type AutoContinueMode = 'goal' | 'goal1' | 'goal2' | 'goal3';

interface AutoContinueAlgorithm {
  id: AutoContinueMode;
  label: string;
  role: string;
  description: string;
  commandName: string;
  bestFor: string;
  strengths: string[];
  weaknesses: string[];
  howItWorks: string;
}

const AUTOCONTINUE_ALGORITHMS: AutoContinueAlgorithm[] = [
  {
    id: 'goal',
    label: 'Kraemer',
    role: 'Executor',
    description: 'Fast TDD loop — reliable for clear specs',
    commandName: 'goal',
    bestFor: 'Clear specs, coding tasks, "just build it" work',
    strengths: [
      'Reliable and balanced speed/cost',
      'Solid TDD discipline — writes tests first, implements, verifies',
      'No overhead from extra validation passes',
    ],
    weaknesses: [
      'Can miss subtle edge cases that need deeper second-pass reasoning',
      'No adversarial self-review — trusts its own DONE claim',
    ],
    howItWorks: 'The goal algorithm runs an autonomous loop where the agent works until it can prove completion, then requests runtime-verified completion. Simple binary loop — no staged validators, no critic, no phase system. The agent drives its own process.',
  },
  {
    id: 'goal1',
    label: 'Kubet',
    role: 'Validator',
    description: 'Adversarial review — catches hidden issues',
    commandName: 'goal1',
    bestFor: 'Correctness-critical tasks — ops planning, complex logic, risk analysis',
    strengths: [
      'Catches hidden issues through forced adversarial self-review',
      'Most reliable outcomes across all task types',
      '3-level validator pipeline ensures nothing slips through',
      'Async process critic monitors efficiency during work',
    ],
    weaknesses: [
      'Slower and more expensive due to validation passes',
      'May over-engineer simple tasks that don\'t need 3 levels of review',
    ],
    howItWorks: 'After the agent claims DONE, the system drives it through a 3-level validator pipeline:\n\nLevel 1 (Format) — Are all files valid? Does the build pass? Any syntax errors?\nLevel 2 (Quality) — Do tests pass? Are requirements traced? Any anti-patterns?\nLevel 3 (Top-Notch) — Adversarial edge cases, performance review, regression sweep.\n\nThe agent must pass each level before advancing. If a level fails, the agent fixes issues and retries that level.\n\nDuring the work phase, an async process critic fires periodically to check: is the agent going in circles? Skipping tests? Gold-plating? The critic injects course-correction prompts without interrupting the task itself.\n\nThe agent cannot skip validators by emitting DONE and VERIFIED together — the system forces the full pipeline.',
  },
  {
    id: 'goal2',
    label: 'Ino',
    role: 'Decomposer',
    description: 'Kanban cards — structured per-module work',
    commandName: 'goal2',
    bestFor: 'Multi-domain tasks — investigations, audits, research, modular systems',
    strengths: [
      'Strong structured breakdown into discrete work units',
      'Each card goes through its own review/test cycle',
      'Thorough coverage of individual domains',
    ],
    weaknesses: [
      'Can underscope — if it doesn\'t create cards for all requirements, the system won\'t catch it',
      'Integration mistakes between independently-built parts',
      'Most expensive due to per-card overhead',
    ],
    howItWorks: 'Work is organized as a kanban board. The agent decomposes the task into cards, each prefixed with a stage:\n\n[BACKLOG] — Waiting to start\n[IN PROGRESS] — Currently being worked on (max 1 at a time)\n[REVIEW] — Self-review checkpoint\n[TESTING] — Run tests for this specific card\n[DONE] — Fully verified\n\nCards progress through stages in order. The system monitors todo items for these prefixes and provides stage-aware continuation prompts. If the agent claims DONE but cards aren\'t all in [DONE], the system rejects it.\n\nAfter all cards complete, a final integration check runs across the whole workspace.',
  },
  {
    id: 'goal3',
    label: 'Saumya',
    role: 'Architect',
    description: 'Entropy search — diverge then compress',
    commandName: 'goal3',
    bestFor: 'Design, strategy, architecture — problems with ambiguity',
    strengths: [
      'Fastest and cheapest across all tasks',
      'Produces clean, well-architected solutions',
      'Genuine strategic exploration — not fake variations',
    ],
    weaknesses: [
      'Implementation detail correctness can slip',
      'Upfront exploration adds no value on spec-driven tasks',
      'Tests may validate internal components without catching integration bugs',
    ],
    howItWorks: 'Uses controlled entropy scheduling — high entropy in search, low entropy in execution.\n\nThe system drives the agent through 5 phases:\n\n1. EXPAND (high entropy) — Reframe the task 5+ ways, list hidden assumptions, generate diverse solution families across multiple lenses.\n\n2. BRANCH (high entropy) — Crystallize 3-5 materially different candidate approaches. Each must differ in strategy, not wording.\n\n3. ATTACK (medium entropy) — Candidates cross-attack each other. Find failure modes, blind spots, merge strongest parts.\n\n4. RANK (low entropy) — Score by robustness/novelty/feasibility. Pick ONE path. No hedging.\n\n5. COMPRESS (minimal entropy) — Execute the ranked winner with TDD. No re-exploring.\n\nThe agent emits phase markers (<phase>X-done</phase>) and the system advances it. DONE before the compress phase is rejected as premature convergence.',
  },
];

function InfinityOff({ className, strokeWidth = 2 }: { className?: string; strokeWidth?: number }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M12 12c-2-2.67-4-4-6-4a4 4 0 1 0 0 8c2 0 4-1.33 6-4Zm0 0c2 2.67 4 4 6 4a4 4 0 0 0 0-8c-2 0-4 1.33-6 4Z" />
      <line x1="4" y1="4" x2="20" y2="20" />
    </svg>
  );
}

const DEFAULT_AUTOCONTINUE_MODE: AutoContinueMode = 'goal';

function AutoContinueSelector({
  selected,
  onSelect,
  commands,
}: {
  selected: AutoContinueMode | null;
  onSelect: (mode: AutoContinueMode | null) => void;
  commands: Command[];
}) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [explicitPick, setExplicitPick] = useState(false);
  const [detailAlg, setDetailAlg] = useState<AutoContinueAlgorithm | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const available = useMemo(
    () =>
      AUTOCONTINUE_ALGORITHMS.filter((alg) =>
        Array.isArray(commands) && commands.some((c) => c.name === alg.commandName),
      ),
    [commands],
  );

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setExpanded(false);
      }
    }
    if (open) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [open]);

  useEffect(() => {
    if (open && selected !== null) {
      setExpanded(true);
    }
  }, [open, selected]);

  if (available.length === 0) return null;

  const isActive = selected !== null;
  const currentAlg = available.find((a) => a.id === selected);

  return (
    <>
      <div className="relative" ref={ref}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => setOpen(!open)}
              className={cn(
                'inline-flex items-center gap-1 h-8 px-2 rounded-full text-xs font-medium transition-colors duration-200 cursor-pointer',
                isActive
                  ? 'text-primary bg-primary/10 hover:bg-primary/15'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted',
              )}
            >
              {isActive ? (
                <Infinity className="size-4" strokeWidth={2.5} />
              ) : (
                <InfinityOff className="size-4" />
              )}
              {isActive && (
                <span className="text-xs">{explicitPick && currentAlg ? currentAlg.label : 'Auto'}</span>
              )}
              <ChevronDown className={cn('size-3 opacity-50 transition-transform duration-200', open && 'rotate-180')} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" className="text-xs">
            {isActive
              ? `AutoContinue: ${currentAlg?.label}`
              : 'AutoContinue off'}
          </TooltipContent>
        </Tooltip>

        {open && (
          <div
            className="absolute bottom-full left-0 mb-1.5 z-50 w-80 bg-popover border border-border rounded-2xl overflow-hidden animate-in fade-in-0 slide-in-from-bottom-2 duration-150"
          >
            <div className="p-1">
              <div className="px-2.5 pt-1.5 pb-1 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                AutoContinue
              </div>

              <button
                onClick={() => { onSelect(null); setExplicitPick(false); setExpanded(false); setOpen(false); }}
                className={cn(
                  'w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-sm transition-colors cursor-pointer',
                  !isActive ? 'bg-muted' : 'hover:bg-muted',
                )}
              >
                <InfinityOff className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="font-medium flex-1 text-left">Off</span>
                {!isActive && <Check className="size-3 text-foreground shrink-0" />}
              </button>

              <button
                onClick={() => {
                  if (!isActive) onSelect(DEFAULT_AUTOCONTINUE_MODE);
                  setExpanded(true);
                }}
                className={cn(
                  'w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-sm transition-colors cursor-pointer',
                  isActive && !expanded ? 'bg-muted' : isActive ? 'bg-primary/5' : 'hover:bg-muted',
                )}
              >
                <Infinity className="size-3.5 shrink-0" strokeWidth={2.5} />
                <span className="font-medium flex-1 text-left">
                  {isActive && explicitPick && currentAlg ? `On — ${currentAlg.label}` : 'On'}
                </span>
                {isActive && !expanded && <Check className="size-3 text-foreground shrink-0" />}
                {!expanded && <ChevronDown className="size-3 text-muted-foreground shrink-0" />}
              </button>

              <div
                className="overflow-hidden transition-colors duration-200 ease-out"
                style={{
                  maxHeight: expanded ? available.length * 40 + 16 : 0,
                  opacity: expanded ? 1 : 0,
                }}
              >
                <div className="mx-2 my-1 border-t border-border" />
                {available.map((alg) => {
                  const isSelected = selected === alg.id;
                  return (
                    <div
                      key={alg.id}
                      className={cn(
                        'flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-sm transition-colors',
                        isSelected ? 'bg-muted' : 'hover:bg-muted',
                      )}
                    >
                      <button
                        onClick={() => { onSelect(alg.id); setExplicitPick(true); setOpen(false); setExpanded(false); }}
                        className="flex items-center gap-2 flex-1 min-w-0 text-left cursor-pointer"
                      >
                        <span className="font-medium shrink-0">{alg.label}</span>
                        <span className="text-xs text-muted-foreground/70 shrink-0">{alg.role}</span>
                        <span className="text-xs text-muted-foreground truncate">{alg.description}</span>
                        {isSelected && <Check className="size-3 text-foreground shrink-0 ml-auto" />}
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); setDetailAlg(alg); setOpen(false); setExpanded(false); }}
                        className="shrink-0 p-0.5 rounded-md text-muted-foreground/50 hover:text-foreground hover:bg-muted-foreground/10 transition-colors cursor-pointer"
                      >
                        <Info className="size-3.5" />
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>

      <Dialog open={detailAlg !== null} onOpenChange={(v) => { if (!v) setDetailAlg(null); }}>
        <DialogContent className="max-w-lg" aria-describedby="alg-detail-desc">
          {detailAlg && (
            <>
              <DialogHeader>
                <div className="flex items-center gap-3">
                  <Infinity className="size-5 text-primary" strokeWidth={2.5} />
                  <DialogTitle className="text-lg">{detailAlg.label}</DialogTitle>
                  <span className="text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded-full font-medium">
                    {detailAlg.role}
                  </span>
                </div>
                <DialogDescription id="alg-detail-desc">
                  {detailAlg.description}
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-4 mt-2">
                <div>
                  <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">Best for</h4>
                  <p className="text-sm">{detailAlg.bestFor}</p>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">Strengths</h4>
                    <ul className="space-y-1">
                      {detailAlg.strengths.map((s, i) => (
                        <li key={i} className="text-sm text-muted-foreground flex gap-1.5">
                          <span className={cn('shrink-0 mt-0.5', STATUS_TEXT.success)}>+</span>
                          <span>{s}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div>
                    <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">Weaknesses</h4>
                    <ul className="space-y-1">
                      {detailAlg.weaknesses.map((w, i) => (
                        <li key={i} className="text-sm text-muted-foreground flex gap-1.5">
                          <span className={cn('shrink-0 mt-0.5', STATUS_TEXT.warning)}>-</span>
                          <span>{w}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>

                <div>
                  <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">How it works</h4>
                  <div className="text-sm text-muted-foreground leading-relaxed whitespace-pre-line bg-muted/50 rounded-2xl p-3">
                    {detailAlg.howItWorks}
                  </div>
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
*/

// ============================================================================
// Token Progress Circle
// ============================================================================

interface TokenProgressProps {
  messages: MessageWithParts[] | undefined;
  models?: FlatModel[];
  selectedModel?: { providerID: string; modelID: string } | null;
  onContextClick?: () => void;
}

function getLastAssistantTokenTotal(messages: MessageWithParts[] | undefined): number {
  if (!messages) return 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.info.role !== 'assistant') continue;
    const t = (msg.info as any).tokens;
    if (!t) continue;
    const total =
      (t.input ?? 0) +
      (t.output ?? 0) +
      (t.reasoning ?? 0) +
      (t.cache?.read ?? 0) +
      (t.cache?.write ?? 0);
    if (total > 0) return total;
  }
  return 0;
}

function getContextLimit(
  models: FlatModel[] | undefined,
  selectedModel: { providerID: string; modelID: string } | null | undefined,
): number {
  if (selectedModel && models) {
    const model = models.find(
      (m) => m.providerID === selectedModel.providerID && m.modelID === selectedModel.modelID,
    );
    if (model?.contextWindow && model.contextWindow > 0) return model.contextWindow;
  }
  return 200000;
}

function TokenProgress({ messages, models, selectedModel, onContextClick }: TokenProgressProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const contextTokens = useMemo(() => getLastAssistantTokenTotal(messages), [messages]);
  const contextLimit = useMemo(
    () => getContextLimit(models, selectedModel),
    [models, selectedModel],
  );
  const ratio = contextTokens > 0 ? Math.min(contextTokens / contextLimit, 1) : 0;

  if (contextTokens === 0 && !onContextClick) return null;

  const color =
    ratio >= 0.9
      ? STATUS_TEXT.destructive
      : ratio > 0.8
        ? STATUS_TEXT.warning
        : 'text-muted-foreground';

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="relative inline-flex">
            <button
              type="button"
              className="flex size-6 cursor-pointer items-center justify-center"
              onPointerDown={(e) => {
                e.stopPropagation();
              }}
              onClick={(e) => {
                e.stopPropagation();
                onContextClick?.();
              }}
            >
              <ProgressRing
                value={Math.round(ratio * 100)}
                className="size-5"
                progressClassName={color}
              />
            </button>
          </span>
        </TooltipTrigger>
        <TooltipContent side="top">
          <div className="space-y-0.5 font-mono text-xs">
            <div>
              Context: {(contextTokens / 1000).toFixed(1)}
              {tHardcodedUi.raw('componentsSessionSessionChatInput.line736JsxTextK')}
              {(contextLimit / 1000).toFixed(0)}
              {tHardcodedUi.raw('componentsSessionSessionChatInput.line736JsxTextKTokens')}
            </div>
            <div className="text-muted-foreground">
              {Math.round(ratio * 100)}
              {tHardcodedUi.raw('componentsSessionSessionChatInput.line737JsxTextUsed')}
            </div>
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

// ============================================================================
// File Attachment Helpers
// ============================================================================

export type AttachedFile =
  | {
      kind: 'local';
      file: File;
      localUrl: string;
      isImage: boolean;
    }
  | {
      kind: 'remote';
      url: string;
      filename: string;
      mime: string;
      isImage: boolean;
    };

function isImageFile(file: File): boolean {
  if (file.type.startsWith('image/')) return true;
  // Fallback: check extension for when MIME type is missing (e.g. pasted files)
  const ext = file.name.split('.').pop()?.toLowerCase() || '';
  return [
    'jpg',
    'jpeg',
    'png',
    'gif',
    'webp',
    'svg',
    'bmp',
    'ico',
    'heic',
    'heif',
    'avif',
  ].includes(ext);
}

// ============================================================================
// Attachment Preview Strip — grid-style file cards
// ============================================================================

/** Thumbnail for a locally attached file (not yet uploaded). */
function AttachmentThumbnail({ af, name }: { af: AttachedFile; name: string }) {
  const [textPreview, setTextPreview] = useState<string | null>(null);
  const ext = name.split('.').pop()?.toLowerCase() || '';

  // Check if this is an image — be generous with detection
  const isImg =
    af.isImage ||
    (af.kind === 'local' && af.file.type.startsWith('image/')) ||
    ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico', 'heic', 'heif', 'avif'].includes(
      ext,
    );

  // HEIC: convert to JPEG for preview (browsers can't render HEIC natively)
  const isHeic = ext === 'heic' || ext === 'heif';
  const [heicUrl, setHeicUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!isHeic || !isImg || af.kind !== 'local') return;
    let cancelled = false;
    let u: string | null = null;
    import('@/lib/utils/heic-convert')
      .then(({ convertHeicBlobToJpeg }) =>
        convertHeicBlobToJpeg(af.file).then((jpeg) => {
          if (cancelled) return;
          u = URL.createObjectURL(jpeg);
          setHeicUrl(u);
        }),
      )
      .catch(() => {});
    return () => {
      cancelled = true;
      if (u) URL.revokeObjectURL(u);
    };
  }, [af, isHeic, isImg]);

  // For local text/code files, read first ~12 lines for preview
  useEffect(() => {
    if (af.kind !== 'local' || isImg) return;
    const textExts = [
      'js',
      'jsx',
      'ts',
      'tsx',
      'py',
      'rb',
      'go',
      'rs',
      'java',
      'c',
      'cpp',
      'h',
      'hpp',
      'css',
      'scss',
      'html',
      'vue',
      'svelte',
      'json',
      'yaml',
      'yml',
      'toml',
      'xml',
      'md',
      'mdx',
      'txt',
      'log',
      'sh',
      'bash',
      'zsh',
      'sql',
      'swift',
      'kt',
      'scala',
      'lua',
      'r',
      'php',
      'pl',
      'ini',
      'conf',
      'env',
      'gitignore',
      'dockerfile',
    ];
    if (!textExts.includes(ext)) return;
    const reader = new FileReader();
    reader.onload = () =>
      setTextPreview((reader.result as string).split('\n').slice(0, 12).join('\n'));
    reader.readAsText(af.file.slice(0, 2048));
  }, [af, ext, isImg]);

  // Image thumbnail — HEIC uses converted URL, everything else uses original
  if (isImg) {
    const src = isHeic ? heicUrl : af.kind === 'local' ? af.localUrl : af.url;
    if (!src) return null; // HEIC still converting — show nothing briefly
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt={name}
        className="absolute inset-0 h-full w-full object-cover"
        draggable={false}
      />
    );
  }

  // Text/code thumbnail
  if (textPreview) {
    return (
      <div className="absolute inset-0 overflow-hidden p-1">
        <pre className="text-muted-foreground/70 pointer-events-none m-0 overflow-hidden p-0 font-mono text-xs leading-[1.4] whitespace-pre select-none">
          {textPreview}
        </pre>
        <div className="from-muted/20 absolute right-0 bottom-0 left-0 h-6 bg-gradient-to-t to-transparent" />
      </div>
    );
  }

  // Fallback: large icon
  return getFileIcon(name, { className: 'h-10 w-10', variant: 'monochrome' });
}

function AttachmentPreview({
  files,
  onRemove,
}: {
  files: AttachedFile[];
  onRemove: (index: number) => void;
}) {
  if (files.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2 px-3 pt-2">
      {files.map((af, i) => {
        const name = af.kind === 'local' ? af.file.name : af.filename;
        const ext = name.split('.').pop()?.toLowerCase() || '';

        return (
          <div key={i} className="group relative">
            <div
              className={cn(
                'border-border/50 flex flex-col overflow-hidden rounded-2xl border',
                'w-[120px] cursor-default select-none',
                'bg-card hover:bg-muted/30 hover:border-border transition-colors duration-150',
              )}
            >
              {/* Thumbnail area */}
              <div className="bg-muted/20 relative flex h-[80px] items-center justify-center overflow-hidden">
                <AttachmentThumbnail af={af} name={name} />
                {/* Extension badge */}
                {ext && !af.isImage && (
                  <span className="text-muted-foreground/50 bg-background/80 absolute right-1 bottom-1 z-[5] rounded px-1 py-0.5 text-xs font-medium tracking-wider uppercase">
                    {ext.toUpperCase()}
                  </span>
                )}
              </div>
              {/* Name bar */}
              <div className="border-border/30 flex h-[32px] items-center border-t px-2 py-1.5">
                <div className="flex w-full min-w-0 items-center gap-1">
                  {getFileIcon(name, { className: 'h-3.5 w-3.5 shrink-0', variant: 'monochrome' })}
                  <span className="text-foreground truncate text-xs">{name}</span>
                </div>
              </div>
            </div>
            {/* Remove button */}
            <button
              onClick={() => onRemove(i)}
              className="border-card absolute -top-1.5 -right-1.5 z-10 flex h-5 w-5 cursor-pointer items-center justify-center rounded-full border-2 bg-black text-white opacity-0 transition-opacity group-hover:opacity-100 dark:bg-white dark:text-black"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

// ============================================================================
// Slash Command Popover — uses fixed positioning to escape overflow-hidden ancestors
// ============================================================================

function SlashCommandPopover({
  commands,
  filter,
  selectedIndex,
  onSelect,
  anchorRef,
}: {
  commands: Command[];
  filter: string;
  selectedIndex: number;
  onSelect: (command: Command) => void;
  anchorRef: React.RefObject<HTMLElement | null>;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const filtered = useMemo(() => {
    const q = filter.toLowerCase();
    return commands.filter(
      (c) =>
        (c.name || '').toLowerCase().includes(q) || (c.description || '').toLowerCase().includes(q),
    );
  }, [commands, filter]);

  // Scroll selected item into view
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const item = container.children[selectedIndex] as HTMLElement | undefined;
    if (item) {
      item.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex]);

  if (filtered.length === 0) return null;

  // Read position synchronously from the anchor ref — fixed positioning
  // escapes overflow-hidden ancestors without needing a portal.
  const el = anchorRef.current;
  if (!el) return null;
  const r = el.getBoundingClientRect();

  return (
    <div
      className="bg-popover border-border/60 fixed z-[99999] overflow-hidden rounded-2xl border"
      style={{
        bottom: window.innerHeight - r.top + 4,
        left: r.left,
        width: Math.min(r.width, 480),
      }}
    >
      <div ref={scrollRef} className="max-h-64 overflow-y-auto py-1">
        {filtered.map((cmd, i) => (
          <button
            key={cmd.name}
            onMouseDown={(e) => {
              e.preventDefault();
              onSelect(cmd);
            }}
            className={cn(
              '-mx-1 flex w-full cursor-pointer flex-col gap-0.5 rounded-2xl border border-transparent px-3 py-2 text-left transition-colors',
              i === selectedIndex ? 'bg-muted border-border/50' : 'hover:bg-muted/50',
            )}
          >
            <span className="text-foreground font-mono text-sm">/{cmd.name}</span>
            {cmd.description && (
              <span className="text-muted-foreground/40 line-clamp-2 text-xs">
                {cmd.description}
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

// ============================================================================
// @ Mention Types & Popover
// ============================================================================

export interface MentionItem {
  kind: 'file' | 'agent' | 'session';
  label: string;
  value?: string;
  description?: string;
}

export interface TrackedMention {
  kind: 'file' | 'agent' | 'session';
  label: string;
  value?: string; // session ID for session mentions
}

function MentionPopover({
  items,
  selectedIndex,
  onSelect,
  loading,
  anchorRef,
}: {
  items: MentionItem[];
  selectedIndex: number;
  onSelect: (item: MentionItem) => void;
  loading?: boolean;
  anchorRef: React.RefObject<HTMLElement | null>;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const listRef = useRef<HTMLDivElement>(null);

  // Scroll selected item into view
  useEffect(() => {
    const el = listRef.current?.querySelector(
      `[data-mention-index="${selectedIndex}"]`,
    ) as HTMLElement | null;
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  const visible = items.length > 0 || !!loading;
  if (!visible) return null;

  const el = anchorRef.current;
  if (!el) return null;
  const r = el.getBoundingClientRect();

  const agents = items.filter((i) => i.kind === 'agent');
  const sessions = items.filter((i) => i.kind === 'session');
  const files = items.filter((i) => i.kind === 'file');

  let globalIndex = 0;

  return (
    <div
      className="bg-popover border-border/60 fixed z-[99999] overflow-hidden rounded-2xl border"
      style={{
        bottom: window.innerHeight - r.top + 4,
        left: r.left,
        width: Math.min(r.width, 480),
      }}
    >
      <div ref={listRef} className="max-h-72 overflow-y-auto py-1">
        {agents.length > 0 && (
          <>
            <div className="text-muted-foreground/50 px-3 py-1 text-xs font-semibold tracking-wider uppercase">
              Agents
            </div>
            {agents.map((item) => {
              const idx = globalIndex++;
              return (
                <button
                  key={`agent-${item.value}`}
                  data-mention-index={idx}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    onSelect(item);
                  }}
                  className={cn(
                    'flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-sm transition-colors',
                    idx === selectedIndex ? 'bg-accent text-accent-foreground' : 'hover:bg-muted',
                  )}
                >
                  <span className="bg-foreground/10 text-foreground/60 flex size-4 shrink-0 items-center justify-center rounded text-xs font-semibold">
                    @
                  </span>
                  <span className="truncate font-medium capitalize">{item.label}</span>
                  {item.description && (
                    <span className="text-muted-foreground/40 truncate text-xs">
                      {item.description}
                    </span>
                  )}
                </button>
              );
            })}
          </>
        )}
        {sessions.length > 0 && (
          <>
            <div className="text-muted-foreground/50 px-3 py-1 text-xs font-semibold tracking-wider uppercase">
              Sessions
            </div>
            {sessions.map((item) => {
              const idx = globalIndex++;
              return (
                <button
                  key={`session-${item.value}`}
                  data-mention-index={idx}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    onSelect(item);
                  }}
                  className={cn(
                    'flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-sm transition-colors',
                    idx === selectedIndex ? 'bg-accent text-accent-foreground' : 'hover:bg-muted',
                  )}
                >
                  <MessageSquare className="text-foreground/50 size-4 shrink-0" />
                  <span className="truncate text-sm font-medium">{item.label}</span>
                  {item.description && (
                    <span className="text-muted-foreground/35 ml-auto truncate text-xs">
                      {item.description}
                    </span>
                  )}
                </button>
              );
            })}
          </>
        )}
        {files.length > 0 && (
          <>
            <div className="text-muted-foreground px-3 py-1 text-xs font-semibold tracking-wider uppercase">
              Files
            </div>
            {files.map((item) => {
              const idx = globalIndex++;
              const filePath = item.value || item.label;
              const isDir = filePath.endsWith('/');
              const cleanPath = isDir ? filePath.slice(0, -1) : filePath;
              const fileName = cleanPath.split('/').pop() || cleanPath;
              return (
                <button
                  key={`file-${item.value}`}
                  data-mention-index={idx}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    onSelect(item);
                  }}
                  className={cn(
                    'flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-sm transition-colors',
                    idx === selectedIndex ? 'bg-accent text-accent-foreground' : 'hover:bg-muted',
                  )}
                >
                  {isDir ? (
                    <Folder className="text-foreground/50 size-4 shrink-0" />
                  ) : (
                    getFileIcon(fileName, { className: 'size-4 shrink-0 text-foreground/50' })
                  )}
                  <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
                    <span className="truncate text-sm font-medium">{fileName}</span>
                    <span className="text-muted-foreground/35 min-w-0 flex-shrink truncate font-mono text-xs">
                      {cleanPath}
                    </span>
                  </div>
                </button>
              );
            })}
          </>
        )}
        {/* Loading indicator while searching for files */}
        {loading && files.length === 0 && (
          <div className="text-muted-foreground/50 flex items-center gap-2 px-3 py-2">
            <Loader2 className="size-3.5 animate-spin" />
            <span className="text-xs">
              {tHardcodedUi.raw('componentsSessionSessionChatInput.line1113JsxTextSearching')}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// SessionChatInput - The unified chat input
// ============================================================================

// --- Todo Chip (inline inside the chat input card, same style as sub-session context) ---

function TodoChip({ sessionId }: { sessionId: string }) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const { data: todos } = useOpenCodeSessionTodo(sessionId);
  const [expanded, setExpanded] = useState(false);

  if (!Array.isArray(todos) || todos.length === 0) return null;

  const completed = todos.filter((t: any) => t.status === 'completed').length;
  const total = todos.length;
  const inProgress = todos.find((t: any) => t.status === 'in_progress');

  // Sort: in_progress first, then pending, then completed/cancelled
  const sorted = [...todos].sort((a: any, b: any) => {
    const order: Record<string, number> = {
      in_progress: 0,
      pending: 1,
      completed: 2,
      cancelled: 3,
    };
    return (order[a.status] ?? 2) - (order[b.status] ?? 2);
  });

  return (
    <div className="bg-muted/50 overflow-hidden rounded-2xl">
      {/* Header row */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="hover:bg-muted/80 flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 transition-colors"
      >
        <ListTodo className="text-muted-foreground size-3.5 flex-shrink-0" />
        <span className="text-muted-foreground min-w-0 flex-1 truncate text-left text-xs">
          {completed} of {total}
          {tHardcodedUi.raw('componentsSessionSessionChatInput.line1153JsxTextTasksDone')}{' '}
          {inProgress && (
            <span className="text-foreground/80 font-medium"> · {inProgress.content}</span>
          )}
        </span>
        <ChevronDown
          className={cn(
            'text-muted-foreground/40 size-3 transition-transform',
            expanded && 'rotate-180',
          )}
        />
      </button>

      {/* Expanded task list */}
      {expanded && (
        <div className="border-border/30 scrollbar-hide max-h-[160px] space-y-px overflow-y-auto border-t px-3 py-1.5">
          {sorted.map((todo: any, i: number) => {
            const done = todo.status === 'completed';
            const cancelled = todo.status === 'cancelled';
            const active = todo.status === 'in_progress';
            if (cancelled) return null;
            return (
              <div
                key={todo.id || i}
                className={cn('flex items-center gap-2 py-0.5', done && 'opacity-40')}
              >
                <span
                  className={cn(
                    'flex size-3 flex-shrink-0 items-center justify-center rounded-sm border',
                    done
                      ? 'border-border bg-muted'
                      : active
                        ? 'border-foreground/30'
                        : 'border-border',
                  )}
                >
                  {done && (
                    <svg viewBox="0 0 12 12" fill="none" width="8" height="8">
                      <path
                        d="M3 7.17905L5.02703 8.85135L9 3.5"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="square"
                        className="text-foreground"
                      />
                    </svg>
                  )}
                  {active && <div className="bg-foreground size-1 rounded-full" />}
                </span>
                <span
                  className={cn(
                    'truncate text-xs leading-tight',
                    done && 'text-muted-foreground line-through',
                    !done && 'text-foreground',
                  )}
                >
                  {todo.content}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export interface SessionChatInputProps {
  onSend: (
    text: string,
    files?: AttachedFile[],
    mentions?: TrackedMention[],
  ) => void | Promise<void>;
  isBusy?: boolean;
  onStop?: () => void;
  agents?: Agent[];
  selectedAgent?: string | null;
  onAgentChange?: (agentName: string | null | undefined) => void;
  commands?: Command[];
  onCommand?: (command: Command, args?: string) => void;
  models?: FlatModel[];
  selectedModel?: { providerID: string; modelID: string } | null;
  onModelChange?: (model: { providerID: string; modelID: string } | null) => void;
  variants?: string[];
  selectedVariant?: string | null;
  onVariantChange?: (variant: string | null | undefined) => void;
  messages?: MessageWithParts[];
  /** Session ID — used for message queue, todo chip, and mention filtering */
  sessionId?: string;
  /** If true, disables the input (e.g. during session creation redirect) */
  disabled?: boolean;
  /** Auto-focus the textarea on mount (default: true on desktop) */
  autoFocus?: boolean;
  placeholder?: string;
  /** Imperative draft prefill used by parent composers for starter prompts. */
  prefill?: { text: string; id: number } | null;

  /** Callback to search files via SDK for @ mentions */
  onFileSearch?: (query: string) => Promise<string[]>;
  /** Full provider list response (for connect/manage provider dialogs) */
  providers?: ProviderListResponse;

  /** Thread/fork context — renders an inline indicator inside the input card */
  threadContext?: {
    variant: 'thread' | 'fork';
    parentTitle: string;
    onBackToParent: () => void;
  };

  /** Callback when the context usage indicator is clicked */
  onContextClick?: () => void;

  /** Slot rendered inside the input card, above the textarea (e.g. queue chip) */
  inputSlot?: React.ReactNode;

  /** Slot rendered inline in the bottom toolbar, just left of the voice button */
  toolbarSlot?: React.ReactNode;

  /** Reply context — shows a banner in the input indicating what's being replied to */
  replyTo?: { text: string } | null;
  /** Callback to clear the reply context */
  onClearReply?: () => void;
  /** When true, a structured question is active — send submits a custom answer instead of a chat message */
  lockForQuestion?: boolean;
  /** Called instead of onSend when lockForQuestion is true and the user submits text */
  onCustomAnswer?: (text: string) => void;
  /** Label for the send button when a question is active (e.g. "Next", "Submit"). Null = default arrow icon. */
  questionButtonLabel?: string | null;
  /** Whether the question action can be performed (controls send button disabled state during questions). */
  questionCanAct?: boolean;
  /** Called when the send button is clicked during a question and there's no text (i.e. the action is next/submit, not a custom answer). */
  onQuestionAction?: () => void;
  /** Number of ESC presses so far (0 = none, 1 = first, 2 = second). Triple-ESC to stop. */
  escCount?: number;
}

function forkDraftKey(sessionId: string) {
  return `opencode_fork_prompt:${sessionId}`;
}

function parseForkDraft(parts: PromptPart[] | null | undefined) {
  if (!parts?.length) return { text: '', files: [] as AttachedFile[] };
  const files: AttachedFile[] = [];
  let text = '';

  for (const part of parts) {
    if (part.type === 'text') {
      text = part.text;
      continue;
    }
    if (part.type !== 'file') continue;
    files.push({
      kind: 'remote',
      url: part.url,
      filename: part.filename || 'Attachment',
      mime: part.mime,
      isImage: part.mime.startsWith('image/'),
    });
  }

  return { text, files };
}

export function SessionChatInput({
  onSend,
  isBusy = false,
  onStop,
  agents = [],
  selectedAgent = null,
  onAgentChange,
  commands = [],
  onCommand,
  models = [],
  selectedModel = null,
  onModelChange,
  variants = [],
  selectedVariant = null,
  onVariantChange,
  messages,
  sessionId,
  disabled = false,
  autoFocus,
  placeholder = 'Ask anything...',
  prefill = null,

  onFileSearch,
  providers,
  threadContext,
  onContextClick,
  inputSlot,
  toolbarSlot,
  replyTo,
  onClearReply,
  lockForQuestion = false,
  onCustomAnswer,
  questionButtonLabel = null,
  questionCanAct = true,
  onQuestionAction,
  escCount = 0,
}: SessionChatInputProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const placeholderVariants = useMemo(
    () => [
      placeholder,
      'Use / to run commands',
      'Reference files with @',
      'Ask about any file in this workspace',
      'Use Cmd+K to open command palette',
      'Press Tab to switch modes',
      'Use Up arrow to recall your last prompt',
      'Use Shift+Enter for a new line',
      'Ask to compact this session when context is full',
      'Ask for changed files and diffs',
      'Mention multiple files like @README.md @src/app.tsx',
      'Reference past sessions with @session-name',
    ],
    [placeholder],
  );
  const [text, setText] = useState('');
  const [placeholderIndex, setPlaceholderIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const highlightRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const [slashFilter, setSlashFilter] = useState<string | null>(null);
  const [slashIndex, setSlashIndex] = useState(0);
  const [stagedCommand, setStagedCommand] = useState<Command | null>(null);
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]);
  // const [autocontinueMode, setAutocontinueMode] = useState<AutoContinueMode | null>(null); // AutoContinue — commented out
  const [isDragOver, setIsDragOver] = useState(false);
  const pathname = normalizeAppPathname(usePathname());
  const isOnboarding = pathname?.startsWith('/onboarding');
  const dragDepthRef = useRef(0);
  const primaryAgents = useMemo(
    () => agents.filter((a) => !a.hidden && a.mode !== 'subagent'),
    [agents],
  );

  // File search: use provided callback or fall back to the SDK directly
  const fileSearchFn = useMemo(() => {
    if (onFileSearch) return onFileSearch;
    return async (query: string): Promise<string[]> => {
      try {
        return await searchWorkspaceFiles(query);
      } catch {
        return [];
      }
    };
  }, [onFileSearch]);

  // @ mention state
  const [mentionQuery, setMentionQuery] = useState<{ query: string; triggerPos: number } | null>(
    null,
  );
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentions, setMentions] = useState<TrackedMention[]>([]);
  const [fileResults, setFileResults] = useState<string[]>([]);
  const [fileSearchLoading, setFileSearchLoading] = useState(false);
  const fileSearchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const fileSearchSeq = useRef(0); // sequence counter to discard stale results
  // Cache of all file results seen during the current mention session.
  // This survives across query changes so that narrowing a query (e.g. "te" → "test")
  // never loses results even if the API returns empty for the longer query.
  const fileResultsCache = useRef<Set<string>>(new Set());

  const savedTextBeforeQuestionRef = useRef('');
  useEffect(() => {
    if (!prefill?.text) return;
    setText(prefill.text);
    setStagedCommand(null);
    setSlashFilter(null);
    setMentionQuery(null);
    setMentions([]);
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(prefill.text.length, prefill.text.length);
      ta.style.height = 'auto';
      ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
      if (highlightRef.current) {
        highlightRef.current.style.height = ta.style.height;
      }
    });
  }, [prefill?.id, prefill?.text]);

  useEffect(() => {
    if (lockForQuestion) {
      // Question appeared — save current draft and clear input
      savedTextBeforeQuestionRef.current = text;
      setText('');
    } else if (savedTextBeforeQuestionRef.current) {
      // Question dismissed — restore the saved draft
      setText(savedTextBeforeQuestionRef.current);
      savedTextBeforeQuestionRef.current = '';
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only react to lockForQuestion changes
  }, [lockForQuestion]);

  useEffect(() => {
    if (!sessionId || typeof window === 'undefined') return;
    const raw = sessionStorage.getItem(forkDraftKey(sessionId));
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as PromptPart[];
      const next = parseForkDraft(parsed);
      setText(next.text);
      setAttachedFiles((prev) => {
        for (const file of prev) {
          if (file.kind === 'local') URL.revokeObjectURL(file.localUrl);
        }
        return next.files;
      });
      setSlashFilter(null);
      setMentionQuery(null);
      setMentions([]);
      requestAnimationFrame(() => textareaRef.current?.focus());
    } catch {
      // ignore malformed stored draft
    }
    sessionStorage.removeItem(forkDraftKey(sessionId));
  }, [sessionId]);

  // ChatGPT-like behavior: if the user starts typing while the textarea is not
  // focused, redirect the keystroke into this textarea and focus it.
  useEffect(() => {
    const isTextEditingElement = (el: Element | null) => {
      if (!el) return false;
      const htmlEl = el as HTMLElement;
      if (htmlEl.isContentEditable) return true;
      const tag = htmlEl.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
    };

    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if (disabled) return;
      if (e.defaultPrevented) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (typeof e.key !== 'string') return;
      if (e.key.length !== 1) return; // printable characters only

      const ta = textareaRef.current;
      if (!ta || ta.offsetParent === null) return;
      if (document.activeElement === ta) return;
      if (isTextEditingElement(document.activeElement)) return;

      e.preventDefault();
      ta.focus();

      const start = ta.selectionStart ?? ta.value.length;
      const end = ta.selectionEnd ?? ta.value.length;
      ta.setRangeText(e.key, start, end, 'end');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    };

    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown);
  }, [disabled]);

  // Sessions for @ mention search
  const { data: allSessions } = useOpenCodeSessions();

  useEffect(() => {
    if (text.trim().length > 0) return;

    const interval = setInterval(() => {
      setPlaceholderIndex((i) => (i + 1) % placeholderVariants.length);
    }, 6000);

    return () => {
      clearInterval(interval);
    };
  }, [text, placeholderVariants.length]);

  // Listen for 'focus-session-textarea' events (dispatched when a session tab
  // is activated from the sidebar or dashboard). Only the visible textarea
  // (inside the active, non-hidden tab) will respond. Retries briefly in case
  // the event fires before React has finished rendering the new tab.
  useEffect(() => {
    const handler = () => {
      const tryFocus = (retries: number) => {
        const el = textareaRef.current;
        if (el && el.offsetParent !== null) {
          el.focus();
          return;
        }
        if (retries > 0) {
          requestAnimationFrame(() => tryFocus(retries - 1));
        }
      };
      tryFocus(10);
    };
    window.addEventListener('focus-session-textarea', handler);
    return () => window.removeEventListener('focus-session-textarea', handler);
  }, []);

  // Default autoFocus: true on desktop, false on mobile
  const shouldAutoFocus = autoFocus ?? (typeof window !== 'undefined' && window.innerWidth >= 640);

  // Focus the textarea whenever it becomes visible (handles mount, tab switch,
  // and new-session creation where the component may mount inside a hidden div
  // that is revealed after a Zustand state update).
  useEffect(() => {
    if (!shouldAutoFocus) return;
    const el = textareaRef.current;
    if (!el) return;

    // If already visible, focus immediately
    if (el.offsetParent !== null) {
      el.focus();
      return;
    }

    // Otherwise observe visibility — the parent div toggles `hidden` via CSS
    // class, so IntersectionObserver will fire when it becomes visible.
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          el.focus();
          observer.disconnect();
        }
      },
      { threshold: 0.1 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [shouldAutoFocus]);

  const appendAttachedFiles = useCallback((files: Iterable<File>) => {
    const newFiles: AttachedFile[] = [];
    for (const file of files) {
      const localUrl = URL.createObjectURL(file);
      newFiles.push({ kind: 'local', file, localUrl, isImage: isImageFile(file) });
    }
    if (newFiles.length === 0) return;
    setAttachedFiles((prev) => [...prev, ...newFiles]);
  }, []);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (disabled || lockForQuestion) {
      e.target.value = '';
      return;
    }
    const files = e.target.files;
    if (!files) return;
    appendAttachedFiles(Array.from(files));
    e.target.value = '';
  };

  const dragHasFiles = useCallback((e: React.DragEvent<HTMLElement>) => {
    return Array.from(e.dataTransfer?.types ?? []).includes('Files');
  }, []);

  const handleDragEnter = useCallback(
    (e: React.DragEvent<HTMLElement>) => {
      if (disabled || lockForQuestion || !dragHasFiles(e)) return;
      e.preventDefault();
      dragDepthRef.current += 1;
      setIsDragOver(true);
    },
    [disabled, lockForQuestion, dragHasFiles],
  );

  const handleDragOver = useCallback(
    (e: React.DragEvent<HTMLElement>) => {
      if (disabled || lockForQuestion || !dragHasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    },
    [disabled, lockForQuestion, dragHasFiles],
  );

  const handleDragLeave = useCallback(
    (e: React.DragEvent<HTMLElement>) => {
      if (!dragHasFiles(e)) return;
      e.preventDefault();
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      if (dragDepthRef.current === 0) {
        setIsDragOver(false);
      }
    },
    [dragHasFiles],
  );

  const handleDropFiles = useCallback(
    (e: React.DragEvent<HTMLElement>) => {
      if (disabled || lockForQuestion || !dragHasFiles(e)) return;
      e.preventDefault();
      dragDepthRef.current = 0;
      setIsDragOver(false);
      const dropped = e.dataTransfer.files;
      if (!dropped || dropped.length === 0) return;
      appendAttachedFiles(Array.from(dropped));
    },
    [appendAttachedFiles, disabled, lockForQuestion, dragHasFiles],
  );

  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      if (disabled || lockForQuestion) return;
      const files = extractClipboardFiles(e.clipboardData);
      // No files on the clipboard — let the browser handle the text paste.
      if (files.length === 0) return;
      e.preventDefault();
      appendAttachedFiles(files);
    },
    [appendAttachedFiles, disabled, lockForQuestion],
  );

  const removeAttachedFile = (index: number) => {
    setAttachedFiles((prev) => {
      const removed = prev[index];
      if (removed?.kind === 'local') URL.revokeObjectURL(removed.localUrl);
      return prev.filter((_, i) => i !== index);
    });
  };

  const filteredCommands = useMemo(() => {
    if (slashFilter === null) return [];
    const q = slashFilter.toLowerCase();
    return commands.filter(
      (c) =>
        (c.name || '').toLowerCase().includes(q) || (c.description || '').toLowerCase().includes(q),
    );
  }, [commands, slashFilter]);

  // Debounced file search for @ mentions
  // Uses a persistent cache (fileResultsCache) so that narrowing a query never
  // loses results — even if the API returns empty for longer queries.
  useEffect(() => {
    clearTimeout(fileSearchTimer.current);
    if (!mentionQuery) {
      setFileResults([]);
      setFileSearchLoading(false);
      fileResultsCache.current.clear();
      return;
    }
    // Immediately apply cached results that match the new query so the popover
    // never flickers empty while waiting for the debounced API call.
    const q = mentionQuery.query.toLowerCase();
    if (fileResultsCache.current.size > 0) {
      const cachedMatches = Array.from(fileResultsCache.current).filter(
        (f) => q.length === 0 || f.toLowerCase().includes(q),
      );
      if (cachedMatches.length > 0) {
        setFileResults(cachedMatches.slice(0, 20));
      }
    }
    setFileSearchLoading(true);
    const seq = ++fileSearchSeq.current;
    const currentQuery = mentionQuery.query;
    fileSearchTimer.current = setTimeout(async () => {
      try {
        const results = await fileSearchFn(currentQuery);
        // Add new results to the persistent cache
        for (const r of results) {
          fileResultsCache.current.add(r);
        }
        // Only apply if this is still the latest request
        if (seq === fileSearchSeq.current) {
          // Merge: API results + cached results that still match the query
          const ql = currentQuery.toLowerCase();
          const cachedMatches = Array.from(fileResultsCache.current).filter(
            (f) => ql.length === 0 || f.toLowerCase().includes(ql),
          );
          const merged = new Set([...results, ...cachedMatches]);
          setFileResults(Array.from(merged).slice(0, 20));
          setFileSearchLoading(false);
        }
      } catch {
        if (seq === fileSearchSeq.current) {
          // On error, fall back to cached results that match
          const ql = currentQuery.toLowerCase();
          const cachedMatches = Array.from(fileResultsCache.current).filter(
            (f) => ql.length === 0 || f.toLowerCase().includes(ql),
          );
          setFileResults(cachedMatches.slice(0, 20));
          setFileSearchLoading(false);
        }
      }
    }, 150);
    return () => clearTimeout(fileSearchTimer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mentionQuery?.query, fileSearchFn]);

  // Build mention popover items: agents (sync) + sessions (sync) + files (async)
  // File results are also filtered client-side against the current query so that
  // previously fetched results remain visible even if a longer query yields fewer
  // server-side results (e.g. SDK returns files for "te" but not for "test").
  const mentionItems = useMemo((): MentionItem[] => {
    if (!mentionQuery) return [];
    const q = mentionQuery.query.toLowerCase();
    const agentItems: MentionItem[] = agents
      .filter((a) => (a.name || '').toLowerCase().includes(q))
      .map((a) => ({ kind: 'agent' as const, label: a.name || '', value: a.name || '' }));

    // Session items: filter by title, session ID, or changed file paths, exclude current/child/archived
    const sessionItems: MentionItem[] = (allSessions ?? [])
      .filter((s: Session) => {
        if (s.parentID || s.time.archived) return false;
        if (s.id === sessionId) return false;
        const title = (s.title || '').toLowerCase();
        if (title.includes(q)) return true;
        // Also match by session ID (e.g. @ses_2ec118d4...)
        if (s.id.toLowerCase().includes(q)) return true;
        // Also match against file paths in summary diffs
        const diffs = s.summary?.diffs;
        if (Array.isArray(diffs)) {
          return diffs.some((d: any) => (d.file || '').toLowerCase().includes(q));
        }
        return false;
      })
      .slice(0, 5)
      .map((s: Session) => {
        const ago = formatRelativeTime(s.time.updated);
        const files = s.summary?.files;
        const desc = files ? `${ago} - ${files} file${files === 1 ? '' : 's'} changed` : ago;
        return { kind: 'session' as const, label: s.title || s.id, value: s.id, description: desc };
      });

    const filteredFiles =
      q.length > 0 ? fileResults.filter((f) => f.toLowerCase().includes(q)) : fileResults;
    const fileItems: MentionItem[] = filteredFiles.map((f) => ({
      kind: 'file' as const,
      label: f,
      value: f,
    }));
    return [...agentItems, ...sessionItems, ...fileItems];
  }, [mentionQuery, agents, allSessions, sessionId, fileResults]);

  // Clamp mention index when items change to prevent out-of-bounds selection
  useEffect(() => {
    if (mentionItems.length > 0) {
      setMentionIndex((i) => Math.min(i, mentionItems.length - 1));
    }
  }, [mentionItems.length]);

  const canSubmit = text.trim().length > 0 || attachedFiles.length > 0;

  const handleSubmit = useCallback(async () => {
    // If a command is staged, execute it with the current text as args
    if (stagedCommand) {
      const args = text.trim();
      onCommand?.(stagedCommand, args || undefined);
      setText('');
      setStagedCommand(null);
      setAttachedFiles((prev) => {
        for (const file of prev) {
          if (file.kind === 'local') URL.revokeObjectURL(file.localUrl);
        }
        return [];
      });
      if (textareaRef.current) textareaRef.current.style.height = 'auto';
      return;
    }

    // If a question is active, route through question logic
    if (lockForQuestion) {
      const trimmed = text.trim();
      if (trimmed && onCustomAnswer) {
        // User typed a custom answer — submit it
        onCustomAnswer(trimmed);
        setText('');
        if (textareaRef.current) textareaRef.current.style.height = 'auto';
        return;
      }
      // No text — perform the question action (next/submit)
      if (onQuestionAction) {
        onQuestionAction();
        return;
      }
      return;
    }

    const trimmed = text.trim();
    if ((!trimmed && attachedFiles.length === 0) || disabled) return;

    /* AutoContinue — commented out
    // AutoContinue intercept: when a mode is armed, route through the
    // corresponding slash command instead of a plain send. The user's
    // text becomes the command's args (= the task description).
    if (autocontinueMode && onCommand) {
      const alg = AUTOCONTINUE_ALGORITHMS.find((a) => a.id === autocontinueMode);
      const cmd = alg && commands.find((c) => c.name === alg.commandName);
      if (cmd) {
        onCommand(cmd, trimmed || undefined);
        setText('');
        setSlashFilter(null);
        setMentionQuery(null);
        setMentions([]);
        for (const af of attachedFiles) {
          if (af.kind === 'local') URL.revokeObjectURL(af.localUrl);
        }
        setAttachedFiles([]);
        if (textareaRef.current) textareaRef.current.style.height = 'auto';
        return;
      }
    }
    */

    // Snapshot files and mentions before clearing
    const filesToSend = attachedFiles.length > 0 ? [...attachedFiles] : undefined;
    const mentionsToSend = mentions.length > 0 ? [...mentions] : undefined;

    // Optimistically clear input
    setText('');
    setSlashFilter(null);
    setMentionQuery(null);
    setMentions([]);
    for (const af of attachedFiles) {
      if (af.kind === 'local') URL.revokeObjectURL(af.localUrl);
    }
    setAttachedFiles([]);
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }

    // Send directly. The OpenCode server serializes concurrent prompt_async
    // calls per-session, so sending while the agent is busy is safe — the
    // server queues it. (No client-side message queue.)
    try {
      await onSend(trimmed, filesToSend, mentionsToSend);
    } catch (err) {
      // Restore the text so the user can retry — AND surface why. Previously
      // this catch was silent, so a failed send looked like the message simply
      // "bounced back" into the box with no explanation.
      setText(trimmed);
      toast.error(
        err instanceof Error && err.message
          ? err.message
          : 'Couldn’t send your message. Please try again.',
      );
    }
  }, [
    text,
    disabled,
    onSend,
    onCommand,
    stagedCommand,
    attachedFiles,
    mentions,
    lockForQuestion,
    onCustomAnswer,
    onQuestionAction,
  ]);

  const handleSelectCommand = (cmd: Command) => {
    // Stage the command — show an args input instead of executing immediately
    setStagedCommand(cmd);
    setText('');
    setSlashFilter(null);
    setSlashIndex(0);
    // Focus textarea for args input
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const handleSelectMention = (item: MentionItem) => {
    if (!mentionQuery) return;
    const before = text.slice(0, mentionQuery.triggerPos);
    const after = text.slice(mentionQuery.triggerPos + 1 + mentionQuery.query.length); // +1 for '@'
    const inserted = `@${item.label} `;
    const newText = before + inserted + after;
    setText(newText);
    setMentions((prev) => [
      ...prev,
      {
        kind: item.kind,
        label: item.label,
        ...(item.kind === 'session' ? { value: item.value } : {}),
      },
    ]);
    setMentionQuery(null);
    setMentionIndex(0);
    setFileResults([]);
    fileResultsCache.current.clear();
    // Refocus and position cursor after inserted mention
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (ta) {
        ta.focus();
        const cursorPos = before.length + inserted.length;
        ta.selectionStart = cursorPos;
        ta.selectionEnd = cursorPos;
        ta.style.height = 'auto';
        const newHeight = Math.min(ta.scrollHeight, 200) + 'px';
        ta.style.height = newHeight;
        if (highlightRef.current) {
          highlightRef.current.style.height = newHeight;
        }
      }
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Staged command: Escape cancels, Enter submits (handled by normal submit flow)
    if (stagedCommand && e.key === 'Escape') {
      e.preventDefault();
      setStagedCommand(null);
      setText('');
      return;
    }

    // @ mention popover keyboard navigation
    if (mentionQuery !== null && (mentionItems.length > 0 || fileSearchLoading)) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (mentionItems.length > 0) setMentionIndex((i) => (i + 1) % mentionItems.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (mentionItems.length > 0)
          setMentionIndex((i) => (i - 1 + mentionItems.length) % mentionItems.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        if (mentionItems.length > 0) {
          e.preventDefault();
          handleSelectMention(mentionItems[mentionIndex]);
          return;
        }
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setMentionQuery(null);
        return;
      }
    }

    if (slashFilter !== null && filteredCommands.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSlashIndex((i) => (i + 1) % filteredCommands.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSlashIndex((i) => (i - 1 + filteredCommands.length) % filteredCommands.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        handleSelectCommand(filteredCommands[slashIndex]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setSlashFilter(null);
        return;
      }
    }

    // Tab cycles through agents when no popover is open
    if (e.key === 'Tab' && primaryAgents.length > 1 && onAgentChange) {
      e.preventDefault();
      const currentIdx = primaryAgents.findIndex((a) => a.name === selectedAgent);
      const nextIdx = (currentIdx + 1) % primaryAgents.length;
      onAgentChange(primaryAgents[nextIdx].name);
      return;
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setText(val);

    // Slash command detection (disabled while a command is staged)
    if (!stagedCommand) {
      const match = val.match(/^\/(\S*)$/);
      if (match) {
        setSlashFilter(match[1]);
        setSlashIndex(0);
      } else {
        setSlashFilter(null);
      }
    }

    // @ mention detection: walk backwards from cursor to find @
    const cursorPos = e.target.selectionStart ?? val.length;
    let mentionDetected = false;
    for (let i = cursorPos - 1; i >= 0; i--) {
      const ch = val[i];
      if (ch === ' ' || ch === '\n') break; // stop at whitespace
      if (ch === '@') {
        // Must be at start of input or preceded by whitespace (not email-like)
        const charBefore = i > 0 ? val[i - 1] : ' ';
        if (charBefore === ' ' || charBefore === '\n' || i === 0) {
          const query = val.slice(i + 1, cursorPos);
          // Don't re-trigger popover for already-tracked mentions
          const isAlreadyTracked = mentions.some((m) => m.label === query);
          if (!isAlreadyTracked) {
            setMentionQuery({ query, triggerPos: i });
            setMentionIndex(0);
            mentionDetected = true;
          }
        }
        break;
      }
    }
    if (!mentionDetected) {
      setMentionQuery(null);
    }

    // Prune tracked mentions whose @label text was deleted
    setMentions((prev) => prev.filter((m) => val.includes(`@${m.label}`)));

    const ta = e.target;
    ta.style.height = 'auto';
    const newHeight = Math.min(ta.scrollHeight, 200) + 'px';
    ta.style.height = newHeight;
    // Sync overlay height
    if (highlightRef.current) {
      highlightRef.current.style.height = newHeight;
    }
  };

  const handleTranscription = useCallback((transcribedText: string) => {
    setText((prev) => (prev ? `${prev} ${transcribedText}` : transcribedText));
  }, []);

  // Build highlighted segments for the overlay behind the textarea
  const highlightSegments = useMemo(() => {
    if (mentions.length === 0 || !text) return null;
    type SegKind = 'file' | 'agent' | 'session';
    // Collect all mention ranges sorted by position
    const ranges: { start: number; end: number; kind: SegKind }[] = [];
    for (const m of mentions) {
      const needle = `@${m.label}`;
      const idx = text.indexOf(needle);
      if (idx !== -1) {
        ranges.push({ start: idx, end: idx + needle.length, kind: m.kind });
      }
    }
    if (ranges.length === 0) return null;
    ranges.sort((a, b) => a.start - b.start || b.end - a.end);

    const segs: { text: string; kind?: SegKind }[] = [];
    let last = 0;
    for (const r of ranges) {
      if (r.start < last) continue;
      if (r.start > last) segs.push({ text: text.slice(last, r.start) });
      segs.push({ text: text.slice(r.start, r.end), kind: r.kind });
      last = r.end;
    }
    if (last < text.length) segs.push({ text: text.slice(last) });
    return segs;
  }, [text, mentions]);

  return (
    <div className="relative z-10 mx-auto w-full max-w-[52rem] shrink-0 px-2 pb-6 sm:px-4">
      {/* Todo panel removed — now inline inside the card as TodoChip */}
      <div
        ref={cardRef}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDropFiles}
        className={cn(
          'bg-card border-border relative z-10 w-full overflow-visible rounded-[24px] border transition-colors',
          isDragOver && 'border-primary',
        )}
      >
        <div className="relative flex w-full flex-col gap-2 overflow-visible">
          {isDragOver && (
            <div className="border-primary/70 bg-primary/5 pointer-events-none absolute inset-0 z-30 flex items-center justify-center rounded-[24px] border-2 border-dashed">
              <span className="bg-background/90 text-foreground rounded-md px-3 py-1 text-xs font-medium">
                {tHardcodedUi.raw(
                  'componentsSessionSessionChatInput.line2038JsxTextDropFilesToAttach',
                )}
              </span>
            </div>
          )}
          {/* Slash command popover (portalled to body to escape overflow-hidden ancestors) */}
          {slashFilter !== null && filteredCommands.length > 0 && (
            <SlashCommandPopover
              commands={commands}
              filter={slashFilter}
              selectedIndex={slashIndex}
              onSelect={handleSelectCommand}
              anchorRef={cardRef}
            />
          )}

          {/* @ Mention popover (portalled to body to escape overflow-hidden ancestors) */}
          {mentionQuery !== null && (mentionItems.length > 0 || fileSearchLoading) && (
            <MentionPopover
              items={mentionItems}
              selectedIndex={mentionIndex}
              onSelect={handleSelectMention}
              loading={fileSearchLoading}
              anchorRef={cardRef}
            />
          )}

          {/* Inline chips: thread context, todos, queue — unified spacing */}
          {(threadContext || sessionId || inputSlot || replyTo) && (
            <div className="mx-3 mt-2.5 flex flex-col gap-1.5 empty:hidden">
              {replyTo && (
                <div className="bg-primary/5 border-primary/10 flex items-center gap-2 rounded-2xl border px-3 py-1.5">
                  <Reply className="text-primary/60 size-3 flex-shrink-0" />
                  <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
                    {replyTo.text.length > 120 ? `${replyTo.text.slice(0, 120)}…` : replyTo.text}
                  </span>
                  {onClearReply && (
                    <button
                      type="button"
                      onClick={onClearReply}
                      className="text-muted-foreground hover:text-foreground flex-shrink-0 transition-colors"
                      aria-label={tHardcodedUi.raw(
                        'componentsSessionSessionChatInput.line2078JsxAttrAriaLabelClearReply',
                      )}
                    >
                      <X className="size-3" />
                    </button>
                  )}
                </div>
              )}
              {threadContext && (
                <button
                  onClick={threadContext.onBackToParent}
                  className={cn(
                    'text-muted-foreground hover:text-foreground hover:bg-muted/80 flex cursor-pointer items-center gap-2 rounded-full px-3 py-1.5 text-xs font-medium transition-colors',
                  )}
                >
                  <ArrowUpLeft className="text-muted-foreground size-3.5 flex-shrink-0 transition-transform group-hover:-translate-x-0.5 group-hover:-translate-y-0.5" />
                  <span className="min-w-0 flex-1 truncate text-left">
                    {threadContext.variant === 'fork' ? 'Fork of' : 'Sub-session of'}{' '}
                    <span className="text-foreground/80 font-medium">
                      {threadContext.parentTitle}
                    </span>
                  </span>
                </button>
              )}
              {sessionId && <TodoChip sessionId={sessionId} />}
              {inputSlot}
            </div>
          )}

          {/* Attached files preview */}
          <AttachmentPreview files={attachedFiles} onRemove={removeAttachedFile} />

          {/* Staged command badge */}
          {stagedCommand && (
            <div className="flex min-w-0 items-center gap-2 px-4 pt-3 pb-0">
              <div className="bg-muted/60 border-border/50 flex max-w-full shrink-0 items-center gap-1.5 rounded-2xl border px-2.5 py-1">
                <Terminal className="text-muted-foreground size-3" />
                <span className="text-foreground max-w-[220px] truncate font-mono text-xs font-medium whitespace-nowrap sm:max-w-[320px]">
                  /{stagedCommand.name}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setStagedCommand(null);
                    setText('');
                  }}
                  className="text-muted-foreground hover:text-foreground ml-0.5 transition-colors"
                  aria-label={tHardcodedUi.raw(
                    'componentsSessionSessionChatInput.line2118JsxAttrAriaLabelCancelCommand',
                  )}
                >
                  <X className="size-3" />
                </button>
              </div>
              {stagedCommand.description && (
                <span className="text-muted-foreground min-w-0 truncate text-xs">
                  {stagedCommand.description}
                </span>
              )}
            </div>
          )}

          <div className="flex max-h-[320px] translate-y-0 flex-col gap-1 px-3.5 opacity-100">
            <div className="relative w-full">
              {/* Sending while the agent is busy already works — Enter (or the
                  send button) posts straight to the server, which queues it
                  per-session. No separate "Add to queue" affordance needed. */}
              {text.trim().length === 0 && !stagedCommand && (
                <div
                  aria-hidden
                  className="text-muted-foreground pointer-events-none absolute top-4 left-0.5 h-6 w-[calc(100%-0.5rem)] overflow-hidden text-base sm:text-sm"
                >
                  {lockForQuestion ? (
                    <div className="absolute inset-0">
                      {questionButtonLabel ? 'Or type your own answer...' : 'Type your answer...'}
                    </div>
                  ) : (
                    <AnimatePresence mode="wait" initial={false}>
                      <motion.div
                        key={`${placeholderIndex}:${placeholderVariants[placeholderIndex]}`}
                        className="absolute inset-0"
                        initial={{ opacity: 0, y: 8 }}
                        animate={{
                          opacity: 1,
                          y: 0,
                          transition: { duration: 0.42, ease: [0.22, 1, 0.36, 1] },
                        }}
                        exit={{
                          opacity: 0,
                          y: -8,
                          transition: { duration: 0.48, ease: [0.2, 0, 0.1, 1] },
                        }}
                      >
                        {placeholderVariants[placeholderIndex]}
                      </motion.div>
                    </AnimatePresence>
                  )}
                </div>
              )}
              {text.trim().length === 0 && stagedCommand && (
                <div
                  aria-hidden
                  className="text-muted-foreground/50 pointer-events-none absolute top-4 left-0.5 text-base sm:text-sm"
                >
                  {tHardcodedUi.raw(
                    'componentsSessionSessionChatInput.line2185JsxTextEnterDetailsAndPressEnterOrPressEsc',
                  )}
                </div>
              )}
              {/* Highlight overlay — mirrors textarea text with colored mention spans */}
              {highlightSegments && (
                <div
                  ref={highlightRef}
                  aria-hidden
                  className="text-foreground pointer-events-none absolute inset-0 px-0.5 pt-4 pb-6 text-base leading-normal break-words whitespace-pre-wrap sm:text-sm"
                >
                  {highlightSegments.map((seg, i) => (
                    <span
                      key={i}
                      className={cn(
                        (seg.kind === 'file' || seg.kind === 'agent' || seg.kind === 'session') &&
                          'border-foreground/40 text-foreground/80 border-b font-medium',
                      )}
                    >
                      {seg.text}
                    </span>
                  ))}
                </div>
              )}
              <textarea
                ref={textareaRef}
                value={text}
                onChange={handleInput}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                onScroll={() => {
                  if (highlightRef.current && textareaRef.current) {
                    highlightRef.current.scrollTop = textareaRef.current.scrollTop;
                  }
                }}
                placeholder=""
                rows={1}
                disabled={disabled}
                className={cn(
                  'placeholder:text-muted-foreground relative max-h-[200px] min-h-[72px] w-full resize-none overflow-y-auto rounded-[24px] border-none bg-transparent px-0.5 pt-4 pb-6 text-base shadow-none outline-none focus-visible:ring-0 disabled:opacity-50 sm:text-sm',
                  highlightSegments && 'caret-foreground text-transparent',
                )}
                autoFocus={shouldAutoFocus}
              />
            </div>
          </div>

          {/* Bottom toolbar */}
          <div className="mb-1.5 flex items-center justify-between gap-1 overflow-visible pr-1.5 pl-2">
            {/* LEFT: Attach + Agent + Model + Variant */}
            <div className="flex min-w-0 items-center gap-0 overflow-visible">
              <input
                ref={fileInputRef}
                type="file"
                accept={tHardcodedUi.raw(
                  'componentsSessionSessionChatInput.line2237JsxAttrAcceptImagePdfTxtMdJsonCsvXmlYaml',
                )}
                multiple
                className="hidden"
                onChange={handleFileSelect}
              />
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="text-muted-foreground hover:text-foreground hover:bg-muted inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-full transition-colors"
                  >
                    <Paperclip className="h-4 w-4" strokeWidth={2} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top">
                  <p>
                    {tHardcodedUi.raw(
                      'componentsSessionSessionChatInput.line2252JsxTextAttachFiles',
                    )}
                  </p>
                </TooltipContent>
              </Tooltip>

              {primaryAgents.length > 0 && onAgentChange && (
                <AgentSelector
                  agents={primaryAgents}
                  selectedAgent={selectedAgent}
                  onSelect={onAgentChange}
                />
              )}
              {models.length > 0 && onModelChange && (
                <ModelSelector
                  models={models}
                  selectedModel={selectedModel}
                  onSelect={onModelChange}
                  providers={providers}
                />
              )}
              {variants.length > 0 && onVariantChange && (
                <VariantSelector
                  variants={variants}
                  selectedVariant={selectedVariant}
                  onSelect={onVariantChange}
                />
              )}

              {/* AutoContinue — commented out
              {commands.length > 0 && onCommand && !isOnboarding && (
                <>

                  <AutoContinueSelector
                    selected={autocontinueMode}
                    onSelect={setAutocontinueMode}
                    commands={commands}
                  />
                </>
              )}
              */}
            </div>

            {/* RIGHT: TokenProgress + Voice + Submit/Stop */}
            <div className="flex shrink-0 items-center gap-0">
              <TokenProgress
                messages={messages}
                models={models}
                selectedModel={selectedModel}
                onContextClick={onContextClick}
              />

              {toolbarSlot}

              <VoiceRecorder onTranscription={handleTranscription} disabled={disabled || isBusy} />

              {isBusy && onStop && !lockForQuestion && (
                <div className="relative flex items-center">
                  {/* ESC hint — matches Kortix tooltip styling (bg-primary rounded-2xl) */}
                  {escCount > 0 && (
                    <div className="animate-in fade-in-0 zoom-in-95 slide-in-from-bottom-2 pointer-events-none absolute right-1/2 bottom-full mb-2 translate-x-1/2 duration-150">
                      <div className="bg-primary text-primary-foreground flex items-center gap-1.5 rounded-2xl px-3 py-1.5 text-xs whitespace-nowrap">
                        <kbd className="bg-background/20 text-primary-foreground inline-flex h-5 min-w-5 items-center justify-center rounded-sm px-1 font-sans text-xs font-medium">
                          ESC
                        </kbd>
                        <span>{escCount === 1 ? '×2 to stop' : '×1 to stop'}</span>
                      </div>
                      {/* Arrow matching TooltipContent */}
                      <div className="-mt-px flex justify-center">
                        <div className="bg-primary size-2.5 -translate-y-[calc(50%_-_2px)] rotate-45 rounded-[2px]" />
                      </div>
                    </div>
                  )}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        size="sm"
                        onClick={onStop}
                        className="h-8 w-8 flex-shrink-0 rounded-full p-0"
                      >
                        <div className="h-3 w-3 rounded-[3px] bg-current" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="top">
                      <p>
                        Stop{' '}
                        <kbd className="bg-background/20 text-primary-foreground ml-1 inline-flex h-5 min-w-5 items-center justify-center rounded-sm px-1 font-sans text-xs font-medium">
                          ESC
                        </kbd>{' '}
                        ×3
                      </p>
                    </TooltipContent>
                  </Tooltip>
                </div>
              )}
              {(!isBusy || lockForQuestion) && (
                <div className="opacity-100">
                  {lockForQuestion && questionButtonLabel && !text.trim() ? (
                    <Button
                      size="sm"
                      disabled={!questionCanAct || disabled}
                      onClick={handleSubmit}
                      className="h-8 flex-shrink-0 rounded-full px-3.5 text-xs font-medium"
                    >
                      {questionButtonLabel}
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      disabled={
                        lockForQuestion
                          ? (!canSubmit && !questionCanAct) || disabled
                          : !canSubmit || disabled
                      }
                      onClick={handleSubmit}
                      className="h-8 w-8 flex-shrink-0 rounded-full p-0"
                    >
                      {disabled ? (
                        <div className="size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
                      ) : (
                        <ArrowUp className="size-4" />
                      )}
                    </Button>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
