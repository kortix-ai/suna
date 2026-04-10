'use client';

import { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import { usePathname } from 'next/navigation';
import { normalizeAppPathname } from '@/lib/instance-routes';
import {
  ArrowUp,
  ArrowDown,
  ArrowUpLeft,
  ChevronDown,
  Check,
  CornerDownLeft,
  GitFork,
  // Info,       // AutoContinue — commented out
  // Infinity,   // AutoContinue — commented out
  Loader2,
  Paperclip,
  X,
  ListPlus,
  ListTodo,
  MessageSquare,
  Terminal,
  Reply,
  Folder,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
/* AutoContinue — commented out
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
*/
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { AnimatePresence, motion } from 'framer-motion';
import { VoiceRecorder } from '@/components/thread/chat-input/voice-recorder';
import { ModelSelector } from './model-selector';
import type {
  MessageWithParts,
  Agent,
  Command,
  ProviderListResponse,
  PromptPart,
} from '@/hooks/opencode/use-opencode-sessions';
import { useOpenCodeSessions, useOpenCodeSessionTodo } from '@/hooks/opencode/use-opencode-sessions';
import { searchWorkspaceFiles } from '@/features/files';
import { getFileIcon } from '@/features/files/components/file-icon';
import type { Session } from '@/hooks/opencode/use-opencode-sessions';

import { useMessageQueueStore } from '@/stores/message-queue-store';
import {
  CommandPopover,
  CommandPopoverTrigger,
  CommandPopoverContent,
  CommandInput,
  CommandList,
  CommandGroup,
  CommandItem,
  CommandFooter,
  CommandKbd,
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
    for (const [modelID, model] of Object.entries(p.models)) {
      const caps = (model as any).capabilities;
      const modalities = (model as any).modalities;
      result.push({
        providerID: p.id,
        providerName: p.name,
        modelID,
        modelName: (model.name || modelID).replace('(latest)', '').trim(),
        variants: model.variants,
        capabilities: caps ? {
          reasoning: caps.reasoning ?? false,
          vision: caps.input?.image ?? false,
          toolcall: caps.toolcall ?? false,
        } : {
          reasoning: (model as any).reasoning ?? false,
          vision: modalities?.input?.includes('image') ?? false,
          toolcall: (model as any).tool_call ?? false,
        },
        contextWindow: (model as any).limit?.context,
        releaseDate: (model as any).release_date,
        family: (model as any).family,
        cost: (model as any).cost ? {
          input: (model as any).cost.input ?? 0,
          output: (model as any).cost.output ?? 0,
        } : undefined,
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
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [flash, setFlash] = useState(false);
  const prevAgentRef = useRef(selectedAgent);

  const primaryAgents = useMemo(() => agents.filter((a) => a.mode !== 'subagent'), [agents]);
  const subAgents = useMemo(() => agents.filter((a) => a.mode === 'subagent'), [agents]);

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
    return primaryAgents.filter((a) =>
      a.name.toLowerCase().includes(q) || (a.description || '').toLowerCase().includes(q),
    );
  }, [primaryAgents, search]);

  const filteredSub = useMemo(() => {
    const q = search.toLowerCase().trim();
    if (!q) return subAgents;
    return subAgents.filter((a) =>
      a.name.toLowerCase().includes(q) || (a.description || '').toLowerCase().includes(q),
    );
  }, [subAgents, search]);

  const currentAgent = agents.find((a) => a.name === selectedAgent) || agents[0];
  const displayName = currentAgent?.name || 'Agent';

  return (
    <CommandPopover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <CommandPopoverTrigger>
            <button
              type="button"
              className={cn(
                'inline-flex items-center gap-1.5 h-8 px-2.5 rounded-xl text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors duration-200 capitalize cursor-pointer',
                flash && 'bg-primary/10 text-foreground',
                open && 'bg-muted text-foreground',
              )}
            >
              <span className="truncate max-w-[100px]">{displayName}</span>
              <ChevronDown className={cn('size-3 opacity-50 transition-transform duration-200', open && 'rotate-180')} />
            </button>
          </CommandPopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs">
          <p>Switch agent <kbd className="ml-1 px-1.5 py-0.5 rounded bg-foreground/10 text-[10px] font-mono">Tab</kbd></p>
        </TooltipContent>
      </Tooltip>

      <CommandPopoverContent side="top" align="start" sideOffset={8} className="w-[300px]">
        <CommandInput
          compact
          placeholder="Search agents..."
          value={search}
          onValueChange={setSearch}
        />

        <CommandList className="max-h-[320px]">
          {/* Primary agents */}
          {filteredPrimary.length > 0 && (
            <CommandGroup heading="Agents" forceMount>
              {filteredPrimary.map((agent) => {
                const isSelected = selectedAgent === agent.name || (!selectedAgent && agent === agents[0]);
                return (
                  <CommandItem
                    key={agent.name}
                    value={`agent-${agent.name}`}
                    onSelect={() => {
                      onSelect(agent.name);
                      setOpen(false);
                    }}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="font-medium truncate capitalize">{agent.name}</span>
                      </div>
                      {agent.description && (
                        <p className="text-[11px] text-muted-foreground/50 leading-snug mt-0.5 line-clamp-1">{agent.description}</p>
                      )}
                    </div>
                    {isSelected && <Check className="size-3.5 text-foreground shrink-0" />}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          )}

          {/* Sub-agents */}
          {filteredSub.length > 0 && (
            <CommandGroup heading="Sub-agents" forceMount>
              {filteredSub.map((agent) => {
                const isSelected = selectedAgent === agent.name;
                return (
                  <CommandItem
                    key={agent.name}
                    value={`subagent-${agent.name}`}
                    onSelect={() => {
                      onSelect(agent.name);
                      setOpen(false);
                    }}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="font-medium truncate capitalize">{agent.name}</span>
                      </div>
                      {agent.description && (
                        <p className="text-[11px] text-muted-foreground/50 leading-snug mt-0.5 line-clamp-1">{agent.description}</p>
                      )}
                    </div>
                    {isSelected && <Check className="size-3.5 text-foreground shrink-0" />}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          )}

          {/* No results */}
          {filteredPrimary.length === 0 && filteredSub.length === 0 && search.trim() && (
            <div className="py-8 text-center text-xs text-muted-foreground/50">
              No agents match &ldquo;{search.trim()}&rdquo;
            </div>
          )}
        </CommandList>

        <CommandFooter>
          <div className="flex items-center gap-1">
            <ArrowUp className="h-3 w-3" />
            <ArrowDown className="h-3 w-3" />
            <span>navigate</span>
          </div>
          <div className="flex items-center gap-1">
            <CornerDownLeft className="h-3 w-3" />
            <span>select</span>
          </div>
          <div className="flex items-center gap-1">
            <CommandKbd>Tab</CommandKbd>
            <span>cycle</span>
          </div>
        </CommandFooter>
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
            "inline-flex items-center gap-1 h-8 px-2.5 rounded-xl text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors cursor-pointer capitalize",
            selectedVariant && "text-foreground",
          )}
        >
          {displayName}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">
        <p className="text-xs">Cycle thinking effort</p>
      </TooltipContent>
    </Tooltip>
  );
}

/* AutoContinue — commented out
// ============================================================================
// AutoContinue Mode Selector
// ============================================================================

export type AutoContinueMode = 'autowork' | 'autowork1' | 'autowork2' | 'autowork3' | 'orchestrate';

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
    id: 'autowork',
    label: 'Kraemer',
    role: 'Executor',
    description: 'Fast TDD loop — reliable for clear specs',
    commandName: 'autowork',
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
    howItWorks: 'The original autowork algorithm. Runs an autonomous loop where the agent works until it emits DONE, then enters a verification phase where it self-reviews and emits VERIFIED. Simple binary loop — no staged validators, no critic, no phase system. The agent drives its own process.',
  },
  {
    id: 'autowork1',
    label: 'Kubet',
    role: 'Validator',
    description: 'Adversarial review — catches hidden issues',
    commandName: 'autowork1',
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
    id: 'autowork2',
    label: 'Ino',
    role: 'Decomposer',
    description: 'Kanban cards — structured per-module work',
    commandName: 'autowork2',
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
    howItWorks: 'Work is organized as a kanban board. The agent decomposes the task into cards, each prefixed with a stage:\n\n[BACKLOG] — Waiting to start\n[IN PROGRESS] — Currently being worked on (max 1 at a time)\n[REVIEW] — Self-review checkpoint\n[TESTING] — Run tests for this specific card\n[DONE] — Fully verified\n\nCards progress through stages in order. The system monitors todo items for these prefixes and provides stage-aware continuation prompts. If the agent claims DONE but cards aren\'t all in [DONE], the system rejects it.\n\nAfter all cards complete, a final integration check runs across the entire project.',
  },
  {
    id: 'autowork3',
    label: 'Saumya',
    role: 'Architect',
    description: 'Entropy search — diverge then compress',
    commandName: 'autowork3',
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
  {
    id: 'orchestrate',
    label: 'Orchestrate',
    role: 'Spawner',
    description: 'Multi-session — parallel workers',
    commandName: 'orchestrate',
    bestFor: 'Large tasks that can be parallelized across independent sub-tasks',
    strengths: [
      'Parallel execution across multiple sessions',
      'Good for large codebases with independent modules',
    ],
    weaknesses: [
      'Coordination overhead between sessions',
      'Not suitable for tightly-coupled work',
    ],
    howItWorks: 'Spawns multiple worker sessions that execute sub-tasks in parallel. The orchestrator decomposes the task, assigns work to workers, and aggregates results. Best for work that naturally splits into independent units.',
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

const DEFAULT_AUTOCONTINUE_MODE: AutoContinueMode = 'autowork';

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
                'inline-flex items-center gap-1 h-8 px-2 rounded-xl text-xs font-medium transition-colors duration-200 cursor-pointer',
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
                <span className="text-[11px]">{explicitPick && currentAlg ? currentAlg.label : 'Auto'}</span>
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
            className="absolute bottom-full left-0 mb-1.5 z-50 w-80 bg-popover border border-border rounded-xl overflow-hidden animate-in fade-in-0 slide-in-from-bottom-2 duration-150"
          >
            <div className="p-1">
              <div className="px-2.5 pt-1.5 pb-1 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                AutoContinue
              </div>

              <button
                onClick={() => { onSelect(null); setExplicitPick(false); setExpanded(false); setOpen(false); }}
                className={cn(
                  'w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-[13px] transition-colors cursor-pointer',
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
                  'w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-[13px] transition-colors cursor-pointer',
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
                        'flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-[13px] transition-colors',
                        isSelected ? 'bg-muted' : 'hover:bg-muted',
                      )}
                    >
                      <button
                        onClick={() => { onSelect(alg.id); setExplicitPick(true); setOpen(false); setExpanded(false); }}
                        className="flex items-center gap-2 flex-1 min-w-0 text-left cursor-pointer"
                      >
                        <span className="font-medium shrink-0">{alg.label}</span>
                        <span className="text-[10px] text-muted-foreground/70 shrink-0">{alg.role}</span>
                        <span className="text-[11px] text-muted-foreground truncate">{alg.description}</span>
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
                          <span className="text-emerald-500 shrink-0 mt-0.5">+</span>
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
                          <span className="text-orange-500 shrink-0 mt-0.5">-</span>
                          <span>{w}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>

                <div>
                  <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">How it works</h4>
                  <div className="text-sm text-muted-foreground leading-relaxed whitespace-pre-line bg-muted/50 rounded-lg p-3">
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
    const total = (t.input ?? 0) + (t.output ?? 0) + (t.reasoning ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0);
    if (total > 0) return total;
  }
  return 0;
}

function getContextLimit(models: FlatModel[] | undefined, selectedModel: { providerID: string; modelID: string } | null | undefined): number {
  if (selectedModel && models) {
    const model = models.find(m => m.providerID === selectedModel.providerID && m.modelID === selectedModel.modelID);
    if (model?.contextWindow && model.contextWindow > 0) return model.contextWindow;
  }
  return 200000;
}

function TokenProgress({ messages, models, selectedModel, onContextClick }: TokenProgressProps) {
  const contextTokens = useMemo(() => getLastAssistantTokenTotal(messages), [messages]);
  const contextLimit = useMemo(() => getContextLimit(models, selectedModel), [models, selectedModel]);
  const ratio = contextTokens > 0 ? Math.min(contextTokens / contextLimit, 1) : 0;

  if (contextTokens === 0 && !onContextClick) return null;

  const circumference = 2 * Math.PI * 7;
  const offset = circumference * (1 - ratio);
  const color = ratio >= 0.9 ? 'text-amber-400'
    : ratio > 0.8 ? 'text-orange-500'
    : 'text-muted-foreground';

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="relative inline-flex">
            <button
              type="button"
              className="size-6 flex items-center justify-center cursor-pointer"
              onPointerDown={(e) => { e.stopPropagation(); }}
              onClick={(e) => { e.stopPropagation(); onContextClick?.(); }}
            >
              <svg className="size-5 -rotate-90" viewBox="0 0 18 18">
                <circle cx="9" cy="9" r="7" fill="none" stroke="currentColor" strokeWidth="2" className="text-muted" />
                <circle cx="9" cy="9" r="7" fill="none" stroke="currentColor" strokeWidth="2"
                  strokeDasharray={circumference} strokeDashoffset={offset} strokeLinecap="round" className={color} />
              </svg>
            </button>
          </span>
        </TooltipTrigger>
        <TooltipContent side="top">
          <div className="text-xs font-mono space-y-0.5">
            <div>Context: {(contextTokens / 1000).toFixed(1)}k / {(contextLimit / 1000).toFixed(0)}k tokens</div>
            <div className="text-muted-foreground">{Math.round(ratio * 100)}% used</div>
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
  return ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico', 'heic', 'heif', 'avif'].includes(ext);
}

// ============================================================================
// Attachment Preview Strip — grid-style file cards
// ============================================================================

/** Thumbnail for a locally attached file (not yet uploaded). */
function AttachmentThumbnail({ af, name }: { af: AttachedFile; name: string }) {
  const [textPreview, setTextPreview] = useState<string | null>(null);
  const ext = name.split('.').pop()?.toLowerCase() || '';

  // Check if this is an image — be generous with detection
  const isImg = af.isImage ||
    (af.kind === 'local' && af.file.type.startsWith('image/')) ||
    ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico', 'heic', 'heif', 'avif'].includes(ext);

  // HEIC: convert to JPEG for preview (browsers can't render HEIC natively)
  const isHeic = ext === 'heic' || ext === 'heif';
  const [heicUrl, setHeicUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!isHeic || !isImg || af.kind !== 'local') return;
    let cancelled = false;
    let u: string | null = null;
    import('@/lib/utils/heic-convert').then(({ convertHeicBlobToJpeg }) =>
      convertHeicBlobToJpeg(af.file).then((jpeg) => {
        if (cancelled) return;
        u = URL.createObjectURL(jpeg);
        setHeicUrl(u);
      }),
    ).catch(() => {});
    return () => { cancelled = true; if (u) URL.revokeObjectURL(u); };
  }, [af, isHeic, isImg]);

  // For local text/code files, read first ~12 lines for preview
  useEffect(() => {
    if (af.kind !== 'local' || isImg) return;
    const textExts = [
      'js', 'jsx', 'ts', 'tsx', 'py', 'rb', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'hpp',
      'css', 'scss', 'html', 'vue', 'svelte', 'json', 'yaml', 'yml', 'toml', 'xml',
      'md', 'mdx', 'txt', 'log', 'sh', 'bash', 'zsh', 'sql', 'swift', 'kt', 'scala',
      'lua', 'r', 'php', 'pl', 'ini', 'conf', 'env', 'gitignore', 'dockerfile',
    ];
    if (!textExts.includes(ext)) return;
    const reader = new FileReader();
    reader.onload = () => setTextPreview((reader.result as string).split('\n').slice(0, 12).join('\n'));
    reader.readAsText(af.file.slice(0, 2048));
  }, [af, ext, isImg]);

  // Image thumbnail — HEIC uses converted URL, everything else uses original
  if (isImg) {
    const src = isHeic ? heicUrl : (af.kind === 'local' ? af.localUrl : af.url);
    if (!src) return null; // HEIC still converting — show nothing briefly
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={src} alt={name} className="absolute inset-0 w-full h-full object-cover" draggable={false} />
    );
  }

  // Text/code thumbnail
  if (textPreview) {
    return (
      <div className="absolute inset-0 p-1 overflow-hidden">
        <pre className="m-0 p-0 text-[6px] leading-[1.4] text-muted-foreground/70 font-mono whitespace-pre overflow-hidden select-none pointer-events-none">
          {textPreview}
        </pre>
        <div className="absolute bottom-0 left-0 right-0 h-6 bg-gradient-to-t from-muted/20 to-transparent" />
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
          <div key={i} className="relative group">
            <div className={cn(
              'flex flex-col rounded-lg border border-border/50 overflow-hidden',
              'w-[120px] cursor-default select-none',
              'bg-card hover:bg-muted/30 hover:border-border transition-colors duration-150',
            )}>
              {/* Thumbnail area */}
              <div className="h-[80px] relative flex items-center justify-center overflow-hidden bg-muted/20">
                <AttachmentThumbnail af={af} name={name} />
                {/* Extension badge */}
                {ext && !af.isImage && (
                  <span className="absolute bottom-1 right-1 text-[0.5rem] font-medium text-muted-foreground/50 uppercase tracking-wider bg-background/80 px-1 py-0.5 rounded z-[5]">
                    {ext.toUpperCase()}
                  </span>
                )}
              </div>
              {/* Name bar */}
              <div className="px-2 py-1.5 border-t border-border/30 h-[32px] flex items-center">
                <div className="flex items-center gap-1 min-w-0 w-full">
                  {getFileIcon(name, { className: 'h-3.5 w-3.5 shrink-0', variant: 'monochrome' })}
                  <span className="text-[11px] truncate text-foreground">{name}</span>
                </div>
              </div>
            </div>
            {/* Remove button */}
            <button
              onClick={() => onRemove(i)}
              className="absolute -top-1.5 -right-1.5 h-5 w-5 rounded-full bg-black dark:bg-white border-2 border-card text-white dark:text-black flex items-center justify-center z-10 cursor-pointer opacity-0 group-hover:opacity-100 transition-opacity"
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
        (c.name || '').toLowerCase().includes(q) ||
        (c.description || '').toLowerCase().includes(q),
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
      className="fixed z-[9999] bg-popover border border-border/60 rounded-lg shadow-lg overflow-hidden"
      style={{ bottom: window.innerHeight - r.top + 4, left: r.left, width: Math.min(r.width, 480) }}
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
              'w-full flex flex-col gap-0.5 px-3 py-2 text-left transition-colors cursor-pointer',
              i === selectedIndex ? 'bg-accent text-accent-foreground' : 'hover:bg-muted',
            )}
          >
            <span className="font-mono text-sm text-foreground">/{cmd.name}</span>
            {cmd.description && (
              <span className="text-xs text-muted-foreground/40 line-clamp-2">{cmd.description}</span>
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
  const listRef = useRef<HTMLDivElement>(null);

  // Scroll selected item into view
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-mention-index="${selectedIndex}"]`) as HTMLElement | null;
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
      className="fixed z-[9999] bg-popover border border-border/60 rounded-lg shadow-lg overflow-hidden"
      style={{ bottom: window.innerHeight - r.top + 4, left: r.left, width: Math.min(r.width, 480) }}
    >
      <div ref={listRef} className="max-h-72 overflow-y-auto py-1">
        {agents.length > 0 && (
          <>
            <div className="px-3 py-1 text-[10px] font-semibold text-muted-foreground/50 uppercase tracking-wider">Agents</div>
            {agents.map((item) => {
              const idx = globalIndex++;
              return (
                <button
                  key={`agent-${item.value}`}
                  data-mention-index={idx}
                  onMouseDown={(e) => { e.preventDefault(); onSelect(item); }}
                  className={cn(
                    'w-full flex items-center gap-2 px-3 py-1.5 text-sm transition-colors cursor-pointer',
                    idx === selectedIndex ? 'bg-accent text-accent-foreground' : 'hover:bg-muted',
                  )}
                >
                  <span className="size-4 rounded flex items-center justify-center bg-purple-500/15 text-purple-500 text-[10px] font-semibold shrink-0">@</span>
                  <span className="truncate font-medium capitalize">{item.label}</span>
                  {item.description && <span className="text-muted-foreground/40 truncate text-[10px]">{item.description}</span>}
                </button>
              );
            })}
          </>
        )}
        {sessions.length > 0 && (
          <>
            <div className="px-3 py-1 text-[10px] font-semibold text-muted-foreground/50 uppercase tracking-wider">Sessions</div>
            {sessions.map((item) => {
              const idx = globalIndex++;
              return (
                <button
                  key={`session-${item.value}`}
                  data-mention-index={idx}
                  onMouseDown={(e) => { e.preventDefault(); onSelect(item); }}
                  className={cn(
                    'w-full flex items-center gap-2 px-3 py-1.5 text-sm transition-colors cursor-pointer',
                    idx === selectedIndex ? 'bg-accent text-accent-foreground' : 'hover:bg-muted',
                  )}
                >
                  <MessageSquare className="size-4 text-emerald-500 shrink-0" />
                  <span className="truncate text-sm font-medium">{item.label}</span>
                  {item.description && <span className="text-[10px] text-muted-foreground/35 truncate ml-auto">{item.description}</span>}
                </button>
              );
            })}
          </>
        )}
        {files.length > 0 && (
          <>
            <div className="px-3 py-1 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Files</div>
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
                  onMouseDown={(e) => { e.preventDefault(); onSelect(item); }}
                  className={cn(
                    'w-full flex items-center gap-2 px-3 py-1.5 text-sm transition-colors cursor-pointer',
                    idx === selectedIndex ? 'bg-accent text-accent-foreground' : 'hover:bg-muted',
                  )}
                >
                  {isDir ? (
                    <Folder className="size-4 shrink-0 text-blue-400" />
                  ) : (
                    getFileIcon(fileName, { className: 'size-4 shrink-0' })
                  )}
                  <div className="flex items-center gap-2 overflow-hidden flex-1 min-w-0">
                    <span className="truncate text-sm font-medium">{fileName}</span>
                    <span className="text-[10px] text-muted-foreground/35 font-mono truncate flex-shrink min-w-0">
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
          <div className="px-3 py-2 flex items-center gap-2 text-muted-foreground/50">
            <Loader2 className="size-3.5 animate-spin" />
            <span className="text-xs">Searching…</span>
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
  const { data: todos } = useOpenCodeSessionTodo(sessionId);
  const [expanded, setExpanded] = useState(false);

  if (!todos || todos.length === 0) return null;

  const completed = todos.filter((t: any) => t.status === 'completed').length;
  const total = todos.length;
  const inProgress = todos.find((t: any) => t.status === 'in_progress');

  // Sort: in_progress first, then pending, then completed/cancelled
  const sorted = [...todos].sort((a: any, b: any) => {
    const order: Record<string, number> = { in_progress: 0, pending: 1, completed: 2, cancelled: 3 };
    return (order[a.status] ?? 2) - (order[b.status] ?? 2);
  });

  return (
    <div className="rounded-xl bg-muted/50 overflow-hidden">
      {/* Header row */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-2 w-full px-3 py-1.5 hover:bg-muted/80 transition-colors cursor-pointer"
      >
        <ListTodo className="size-3.5 text-muted-foreground flex-shrink-0" />
        <span className="text-xs text-muted-foreground flex-1 min-w-0 truncate text-left">
          {completed} of {total} tasks done
          {inProgress && (
            <span className="text-foreground/80 font-medium"> · {inProgress.content}</span>
          )}
        </span>
        <ChevronDown className={cn('size-3 text-muted-foreground/40 transition-transform', expanded && 'rotate-180')} />
      </button>

      {/* Expanded task list */}
      {expanded && (
        <div className="border-t border-border/30 max-h-[160px] overflow-y-auto scrollbar-hide px-3 py-1.5 space-y-px">
          {sorted.map((todo: any, i: number) => {
            const done = todo.status === 'completed';
            const cancelled = todo.status === 'cancelled';
            const active = todo.status === 'in_progress';
            if (cancelled) return null;
            return (
              <div key={todo.id || i} className={cn(
                'flex items-center gap-2 py-0.5',
                done && 'opacity-40',
              )}>
                <span className={cn(
                  'size-3 rounded-sm flex-shrink-0 flex items-center justify-center border',
                  done ? 'border-border bg-muted' : active ? 'border-foreground/30' : 'border-border',
                )}>
                  {done && (
                    <svg viewBox="0 0 12 12" fill="none" width="8" height="8"><path d="M3 7.17905L5.02703 8.85135L9 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" className="text-foreground" /></svg>
                  )}
                  {active && <div className="size-1 rounded-full bg-foreground" />}
                </span>
                <span className={cn(
                  'text-[11px] leading-tight truncate',
                  done && 'line-through text-muted-foreground',
                  !done && 'text-foreground',
                )}>
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
  onSend: (text: string, files?: AttachedFile[], mentions?: TrackedMention[]) => void | Promise<void>;
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

  onFileSearch,
  providers,
  threadContext,
  onContextClick,
  inputSlot,
  replyTo,
  onClearReply,
  lockForQuestion = false,
  onCustomAnswer,
  questionButtonLabel = null,
  questionCanAct = true,
  onQuestionAction,
  escCount = 0,
}: SessionChatInputProps) {
  const placeholderVariants = useMemo(
    () => [
      placeholder,
      'Use / to run commands',
      'Reference files with @',
      'Ask about any file in this project',
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

  // File search: use provided callback or fall back to the SDK directly
  const fileSearchFn = useMemo(() => {
    if (onFileSearch) return onFileSearch;
    return async (query: string): Promise<string[]> => {
      try { return await searchWorkspaceFiles(query); } catch { return []; }
    };
  }, [onFileSearch]);

  // @ mention state
  const [mentionQuery, setMentionQuery] = useState<{ query: string; triggerPos: number } | null>(null);
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

  const handleDragEnter = useCallback((e: React.DragEvent<HTMLElement>) => {
    if (disabled || lockForQuestion || !dragHasFiles(e)) return;
    e.preventDefault();
    dragDepthRef.current += 1;
    setIsDragOver(true);
  }, [disabled, lockForQuestion, dragHasFiles]);

  const handleDragOver = useCallback((e: React.DragEvent<HTMLElement>) => {
    if (disabled || lockForQuestion || !dragHasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }, [disabled, lockForQuestion, dragHasFiles]);

  const handleDragLeave = useCallback((e: React.DragEvent<HTMLElement>) => {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setIsDragOver(false);
    }
  }, [dragHasFiles]);

  const handleDropFiles = useCallback((e: React.DragEvent<HTMLElement>) => {
    if (disabled || lockForQuestion || !dragHasFiles(e)) return;
    e.preventDefault();
    dragDepthRef.current = 0;
    setIsDragOver(false);
    const dropped = e.dataTransfer.files;
    if (!dropped || dropped.length === 0) return;
    appendAttachedFiles(Array.from(dropped));
  }, [appendAttachedFiles, disabled, lockForQuestion, dragHasFiles]);

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
        (c.name || '').toLowerCase().includes(q) ||
        (c.description || '').toLowerCase().includes(q),
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

    const filteredFiles = q.length > 0
      ? fileResults.filter((f) => f.toLowerCase().includes(q))
      : fileResults;
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

  const enqueue = useMessageQueueStore((s) => s.enqueue);
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
    // Don't revoke URLs for files going into the queue — they're still needed
    if (!isBusy) {
      for (const af of attachedFiles) {
        if (af.kind === 'local') URL.revokeObjectURL(af.localUrl);
      }
    }
    setAttachedFiles([]);
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }

    // If busy, queue the message instead of sending immediately
    if (isBusy && sessionId) {
      enqueue(sessionId, trimmed, filesToSend);
      return;
    }

    try {
      await onSend(trimmed, filesToSend, mentionsToSend);
    } catch {
      // Restore the text so the user can retry
      setText(trimmed);
    }
  }, [text, isBusy, disabled, onSend, onCommand, stagedCommand, attachedFiles, mentions, sessionId, enqueue, lockForQuestion, onCustomAnswer, onQuestionAction]);

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
    setMentions((prev) => [...prev, { kind: item.kind, label: item.label, ...(item.kind === 'session' ? { value: item.value } : {}) }]);
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
        if (mentionItems.length > 0) setMentionIndex((i) => (i - 1 + mentionItems.length) % mentionItems.length);
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
    if (e.key === 'Tab' && agents.length > 1 && onAgentChange) {
      e.preventDefault();
      const currentIdx = agents.findIndex((a) => a.name === selectedAgent);
      const nextIdx = (currentIdx + 1) % agents.length;
      onAgentChange(agents[nextIdx].name);
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
    // Collect all mention ranges sorted by position
    const ranges: { start: number; end: number; kind: 'file' | 'agent' | 'session' }[] = [];
    for (const m of mentions) {
      const needle = `@${m.label}`;
      const idx = text.indexOf(needle);
      if (idx !== -1) {
        ranges.push({ start: idx, end: idx + needle.length, kind: m.kind });
      }
    }
    if (ranges.length === 0) return null;
    ranges.sort((a, b) => a.start - b.start || b.end - a.end);

    const segs: { text: string; kind?: 'file' | 'agent' | 'session' }[] = [];
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
    <div className="mx-auto w-full max-w-[52rem] relative shrink-0 px-2 sm:px-4 pb-6">
      {/* Todo panel removed — now inline inside the card as TodoChip */}
      <div
        ref={cardRef}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDropFiles}
        className={cn(
          'w-full bg-card border border-border rounded-[24px] overflow-visible relative z-10 transition-colors',
          isDragOver && 'border-primary',
        )}
      >
        <div className="relative flex flex-col w-full gap-2 overflow-visible">
          {isDragOver && (
            <div className="absolute inset-0 z-30 rounded-[24px] border-2 border-dashed border-primary/70 bg-primary/5 pointer-events-none flex items-center justify-center">
              <span className="px-3 py-1 rounded-md bg-background/90 text-xs font-medium text-foreground">
                Drop files to attach
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
            <div className="flex flex-col gap-1.5 mx-3 mt-2.5 empty:hidden">
              {replyTo && (
                <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-primary/5 border border-primary/10">
                  <Reply className="size-3 text-primary/60 flex-shrink-0" />
                  <span className="text-xs text-muted-foreground flex-1 min-w-0 truncate">
                    {replyTo.text.length > 120 ? `${replyTo.text.slice(0, 120)}…` : replyTo.text}
                  </span>
                  {onClearReply && (
                    <button
                      type="button"
                      onClick={onClearReply}
                      className="text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
                      aria-label="Clear reply"
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
                    'flex items-center gap-2 px-3 py-1.5 rounded-xl text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted/80 transition-colors cursor-pointer',
                  )}
                >
                  <ArrowUpLeft className="size-3.5 text-muted-foreground group-hover:-translate-x-0.5 group-hover:-translate-y-0.5 transition-transform flex-shrink-0" />
                  <span className="flex-1 min-w-0 truncate text-left">
                    {threadContext.variant === 'fork' ? 'Fork of' : 'Sub-session of'}
                    {' '}
                    <span className="text-foreground/80 font-medium">{threadContext.parentTitle}</span>
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
            <div className="flex items-center gap-2 px-4 pt-3 pb-0 min-w-0">
              <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-muted/60 border border-border/50 shrink-0 max-w-full">
                <Terminal className="size-3 text-muted-foreground" />
                <span className="font-mono text-xs font-medium text-foreground whitespace-nowrap max-w-[220px] sm:max-w-[320px] truncate">/{stagedCommand.name}</span>
                <button
                  type="button"
                  onClick={() => { setStagedCommand(null); setText(''); }}
                  className="ml-0.5 text-muted-foreground hover:text-foreground transition-colors"
                  aria-label="Cancel command"
                >
                  <X className="size-3" />
                </button>
              </div>
              {stagedCommand.description && <span className="text-xs text-muted-foreground truncate min-w-0">{stagedCommand.description}</span>}
            </div>
          )}

          <div
            className="flex flex-col gap-1 px-3.5 max-h-[320px] opacity-100 translate-y-0"
          >
            <div className="relative w-full">
              {/* Add to queue button — floats top-right of textarea when busy and text is typed */}
              {isBusy && canSubmit && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="sm"
                      onClick={handleSubmit}
                      variant="ghost"
                      className="absolute right-0 top-1 z-20 h-7 gap-1.5 rounded-lg px-2.5 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted/80"
                    >
                      <ListPlus className="size-3.5" />
                      <span>Queue</span>
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="top"><p>Add to queue</p></TooltipContent>
                </Tooltip>
              )}
              {text.trim().length === 0 && !stagedCommand && (
                <div
                  aria-hidden
                  className="absolute left-0.5 top-4 h-6 w-[calc(100%-0.5rem)] text-base sm:text-[15px] text-muted-foreground pointer-events-none overflow-hidden"
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
                  className="absolute left-0.5 top-4 text-base sm:text-[15px] text-muted-foreground/50 pointer-events-none"
                >
                  Enter details and press Enter, or press Esc to cancel
                </div>
              )}
              {/* Highlight overlay — mirrors textarea text with colored mention spans */}
              {highlightSegments && (
                <div
                  ref={highlightRef}
                  aria-hidden
                  className="absolute inset-0 pointer-events-none px-0.5 pb-6 pt-4 text-base sm:text-[15px] whitespace-pre-wrap break-words leading-normal text-foreground"
                >
                  {highlightSegments.map((seg, i) => (
                    <span
                      key={i}
                      className={cn(
                        seg.kind === 'file' && 'text-blue-500 font-medium',
                        seg.kind === 'agent' && 'text-purple-500 font-medium',
                        seg.kind === 'session' && 'text-emerald-500 font-medium',
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
                onScroll={() => {
                  if (highlightRef.current && textareaRef.current) {
                    highlightRef.current.scrollTop = textareaRef.current.scrollTop;
                  }
                }}
                placeholder=""
                rows={1}
                disabled={disabled}
                className={cn(
                  'relative w-full bg-transparent border-none shadow-none focus-visible:ring-0 px-0.5 pb-6 pt-4 min-h-[72px] max-h-[200px] overflow-y-auto resize-none rounded-[24px] text-base sm:text-[15px] outline-none placeholder:text-muted-foreground disabled:opacity-50',
                  highlightSegments && 'caret-foreground text-transparent',
                )}
                autoFocus={shouldAutoFocus}
              />
            </div>
          </div>

          {/* Bottom toolbar */}
          <div className="flex items-center justify-between mb-1.5 pl-2 pr-1.5 gap-1 overflow-visible">
            {/* LEFT: Attach + Agent + Model + Variant */}
            <div className="flex items-center gap-0 min-w-0 overflow-visible">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*,.pdf,.txt,.md,.json,.csv,.xml,.yaml,.yml,.toml,.js,.ts,.jsx,.tsx,.py,.rb,.go,.rs,.java,.c,.cpp,.h,.css,.html,.vue,.svelte,.log,.sql,.zip,.tar,.gz,.rar"
                multiple
                className="hidden"
                onChange={handleFileSelect}
              />
                <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="inline-flex items-center justify-center h-8 w-8 rounded-xl transition-colors text-muted-foreground hover:text-foreground hover:bg-muted cursor-pointer"
                  >
                    <Paperclip className="h-4 w-4" strokeWidth={2} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top"><p>Attach files</p></TooltipContent>
              </Tooltip>

              {agents.length > 0 && onAgentChange && (
                <AgentSelector
                  agents={agents}
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
            <div className="flex items-center gap-0 shrink-0">
              <TokenProgress messages={messages} models={models} selectedModel={selectedModel} onContextClick={onContextClick} />

              <VoiceRecorder
                onTranscription={handleTranscription}
                disabled={disabled || isBusy}
              />

              {isBusy && onStop && !lockForQuestion && (
                <div className="relative flex items-center">
                  {/* ESC hint — matches Kortix tooltip styling (bg-primary rounded-2xl) */}
                  {escCount > 0 && (
                    <div
                      className="absolute bottom-full right-1/2 translate-x-1/2 mb-2 pointer-events-none animate-in fade-in-0 zoom-in-95 slide-in-from-bottom-2 duration-150"
                    >
                      <div className="bg-primary text-primary-foreground rounded-2xl px-3 py-1.5 text-xs whitespace-nowrap flex items-center gap-1.5">
                        <kbd className="bg-background/20 text-primary-foreground inline-flex h-5 min-w-5 items-center justify-center rounded-sm px-1 font-sans text-[11px] font-medium">ESC</kbd>
                        <span>{escCount === 1 ? '×2 to stop' : '×1 to stop'}</span>
                      </div>
                      {/* Arrow matching TooltipContent */}
                      <div className="flex justify-center -mt-px">
                        <div className="bg-primary size-2.5 rotate-45 rounded-[2px] -translate-y-[calc(50%_-_2px)]" />
                      </div>
                    </div>
                  )}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        size="sm"
                        onClick={onStop}
                        className="flex-shrink-0 h-8 w-8 rounded-full p-0"
                      >
                        <div className="w-3 h-3 rounded-[3px] bg-current" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="top">
                      <p>Stop <kbd className="ml-1 bg-background/20 text-primary-foreground inline-flex h-5 min-w-5 items-center justify-center rounded-sm px-1 font-sans text-[10px] font-medium">ESC</kbd> ×3</p>
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
							className="flex-shrink-0 h-8 rounded-full px-3.5 text-xs font-medium"
						>
                      {questionButtonLabel}
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      disabled={lockForQuestion ? (!canSubmit && !questionCanAct) || disabled : !canSubmit || disabled}
                      onClick={handleSubmit}
                      className="flex-shrink-0 h-8 w-8 rounded-full p-0"
                    >
                      {disabled ? (
                        <div className="size-3.5 border-2 border-current border-t-transparent rounded-full animate-spin" />
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
