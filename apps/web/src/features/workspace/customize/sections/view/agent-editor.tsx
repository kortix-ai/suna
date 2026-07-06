'use client';

/**
 * The full v2 "agent builder" — the complete editor for one `agents.<name>`
 * block in a kortix_version 2 manifest (agent-first spec §2.2). Exposes the
 * ENTIRE agent-config field space: identity, behavior/model, Kortix governance
 * (skills/connectors/secrets/kortix_cli), and the full OpenCode permission tree.
 *
 * Mounted from agents-view.tsx's detail aside via <AgentConfigEditor/>:
 *   - v2 project (editable) → a compact summary card + "Edit configuration",
 *     which opens the full grouped editor in a Modal.
 *   - v1 project (not editable) → renders the caller's `fallback` (the legacy
 *     model + scope cards) plus an "upgrade to v2" hint. We degrade, never crash.
 *
 * Saves round-trip the whole block to kortix.yaml via the agent-config route,
 * validated server-side against the manifest-schema validator before commit.
 */

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure';
import Hint from '@/components/ui/hint';
import { InfoBanner } from '@/components/ui/info-banner';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import Loading from '@/components/ui/loading';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/modal';
import { Skeleton } from '@/components/ui/skeleton';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { ModelSelector } from '@/features/session/model-selector';
import { flattenModels } from '@/features/session/session-chat-input';
import {
  useAgentConfig,
  useUpdateAgentConfig,
} from '@/hooks/projects/use-agent-config';
import { useOpenCodeProviders } from '@/hooks/opencode/use-opencode-sessions';
import { errorToast, successToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import {
  type AgentConfigBlock,
  type AgentGrantSetV2,
  listConnectors,
  listProjectSecrets,
  type OpencodeAgentConfig,
  type PermissionAction,
  type PermissionConfig,
  type PermissionRule,
  type ProjectConfigSummary,
} from '@kortix/sdk/projects-client';
import { modelKeyToWire, wireToModelKey } from '@kortix/sdk/react';
import { useQuery } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import { Bot, Cpu, Gauge, Layers, Plus, ShieldCheck, Sliders, Trash2, X } from 'lucide-react';
import { useMemo, useState } from 'react';

// ─── Field-space catalogs ──────────────────────────────────────────────────

const AGENT_MODES = ['primary', 'subagent', 'all'] as const;
const AGENT_MODE_HELP: Record<(typeof AGENT_MODES)[number], string> = {
  primary: 'Selectable as the main agent for a session.',
  subagent: 'Callable by other agents only — not selectable directly.',
  all: 'Available both as primary and as a subagent.',
};
const THEME_COLORS = [
  'primary',
  'secondary',
  'accent',
  'success',
  'warning',
  'error',
  'info',
] as const;
const WORKSPACE_MODES = ['runtime', 'read', 'branch'] as const;
const WORKSPACE_MODE_HELP: Record<(typeof WORKSPACE_MODES)[number], string> = {
  runtime: 'Works directly in the live project workspace.',
  read: 'Can read files but cannot modify them.',
  branch: 'Works on an isolated git branch, merged in later.',
};
const PERMISSION_ACTIONS = ['allow', 'ask', 'deny'] as const;

// Permission keys that accept the full rule form (bare action OR glob-map).
// `skill` is intentionally EXCLUDED — the Skills governance control below owns
// `permission.skill` (the compiler maps `skills:` onto it), so exposing it here
// too would give two controls fighting over one key.
export const PERMISSION_RULE_KEYS = [
  'read',
  'edit',
  'glob',
  'grep',
  'list',
  'bash',
  'task',
  'external_directory',
  'lsp',
] as const;
// Permission keys that only ever take a bare action (no glob-map form upstream).
export const PERMISSION_ACTION_ONLY_KEYS = [
  'todowrite',
  'question',
  'webfetch',
  'websearch',
  'doom_loop',
] as const;

export const PERMISSION_RULE_GROUPS: { label: string; keys: (typeof PERMISSION_RULE_KEYS)[number][] }[] = [
  { label: 'Files & search', keys: ['read', 'edit', 'glob', 'grep', 'list'] },
  { label: 'Execution', keys: ['bash', 'task', 'external_directory', 'lsp'] },
];

export const PERMISSION_KEY_HELP: Record<string, string> = {
  read: 'Read file contents.',
  edit: 'Create or modify files.',
  glob: 'Find files by name pattern.',
  grep: 'Search file contents by pattern.',
  list: 'List directory contents.',
  bash: 'Run shell commands.',
  task: 'Launch a subagent to run a task.',
  external_directory: 'Access paths outside this project workspace.',
  lsp: 'Use language-server tooling — go-to-definition, diagnostics.',
  todowrite: "Maintain the session's todo list.",
  question: 'Ask the user a clarifying question mid-run.',
  webfetch: "Fetch a URL's contents.",
  websearch: 'Run a web search.',
  doom_loop: 'Auto-break a detected repeat-failure loop.',
};

/**
 * The grantable `kortix_cli` action catalog, grouped for the picker. MUST stay
 * in sync with `GRANTABLE_KORTIX_CLI_ACTIONS` in @kortix/manifest-schema (=
 * PROJECT_ACTIONS in apps/api iam/actions.ts MINUS ACCOUNT_ONLY_PROJECT_ACTIONS
 * — project.delete / project.members.manage / project.gateway.keys.manage,
 * promoted to ACCOUNT owner/admin authority by the project-role collapse, see
 * apps/api/src/iam/role-perms.ts). Mirrored here (not imported) because the
 * manifest-schema/api packages aren't in the web bundle — same mirror
 * discipline as apps/web/src/lib/project-actions.ts.
 *
 * Account-scoped admin actions (member.*, billing.*, token.*, project.create,
 * …) are ALSO absent — but that omission is a UX curation choice, not the
 * security boundary: every agent-session token is project-scoped, and
 * apps/api's IAM v2 engine refuses any account-scope action for a
 * project-bound token before an agent's grant is even consulted (see
 * `iam/engine-v2.ts`'s `computeTokenScope`).
 */
export const KORTIX_CLI_CATALOG: { group: string; actions: string[] }[] = [
  { group: 'Project', actions: ['project.read', 'project.write', 'project.deploy'] },
  { group: 'Change requests', actions: ['project.cr.open', 'project.cr.merge'] },
  {
    group: 'Sessions',
    actions: ['project.session.read', 'project.session.start', 'project.session.stop'],
  },
  { group: 'Members', actions: ['project.members.read'] },
  {
    group: 'Triggers',
    actions: [
      'project.trigger.read',
      'project.trigger.create',
      'project.trigger.update',
      'project.trigger.delete',
      'project.trigger.fire',
    ],
  },
  {
    group: 'LLM gateway',
    actions: [
      'project.gateway.logs.read',
      'project.gateway.spend.read',
      'project.gateway.budget.set',
    ],
  },
  {
    group: 'Configuration',
    actions: [
      'project.agent.read',
      'project.agent.write',
      'project.skill.read',
      'project.skill.write',
      'project.command.read',
      'project.command.write',
      'project.file.read',
      'project.file.write',
      'project.customize.read',
      'project.customize.write',
    ],
  },
  {
    group: 'Git',
    actions: ['project.gitops.read', 'project.gitops.push', 'project.gitops.merge'],
  },
  { group: 'Secrets', actions: ['project.secret.read', 'project.secret.write'] },
  { group: 'Connectors', actions: ['project.connector.read', 'project.connector.write'] },
  {
    group: 'Review',
    actions: ['project.review.read', 'project.review.submit', 'project.review.act'],
  },
];

// ─── Small primitives (design-system aligned) ──────────────────────────────

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  allowUnset,
}: {
  options: readonly { value: T; label: string }[];
  value: T | undefined;
  onChange: (v: T | undefined) => void;
  /** When set, clicking the active option again clears it (back to inherit). */
  allowUnset?: boolean;
}) {
  return (
    <div className="border-border/70 inline-flex overflow-hidden rounded-md border">
      {options.map((o) => {
        const active = value === o.value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(allowUnset && active ? undefined : o.value)}
            className={cn(
              'px-2.5 py-1.5 text-xs capitalize transition-[color,background-color,transform] active:scale-[0.96]',
              active
                ? 'bg-secondary text-foreground font-medium'
                : 'text-muted-foreground hover:bg-muted/50',
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function FieldRow({
  label,
  hint,
  children,
}: {
  label: React.ReactNode;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline gap-2">
        <Label className="text-xs">{label}</Label>
        {hint ? <span className="text-muted-foreground/60 text-[11px]">{hint}</span> : null}
      </div>
      {children}
    </div>
  );
}

/** All · Pick · None, with a checklist of the project's declared items when
 *  in Pick mode. The one governance control reused for skills/connectors/secrets. */
function GrantSetField({
  value,
  onChange,
  options,
  emptyLabel,
  allLabel,
}: {
  value: AgentGrantSetV2 | undefined;
  onChange: (v: AgentGrantSetV2) => void;
  options: { id: string; label: string }[];
  emptyLabel: string;
  allLabel: string;
}) {
  const mode: 'all' | 'pick' | 'none' =
    value === 'all' ? 'all' : value === 'none' || value === undefined ? 'none' : 'pick';
  const [wantPick, setWantPick] = useState(Array.isArray(value) && value.length > 0);
  const effectiveMode = value === 'all' ? 'all' : Array.isArray(value) && (value.length > 0 || wantPick) ? 'pick' : mode;
  const selected = new Set(Array.isArray(value) ? value : []);
  const optionIds = new Set(options.map((o) => o.id));
  const orphans = [...selected].filter((id) => !optionIds.has(id)).map((id) => ({ id, label: id }));
  const rows = [...options, ...orphans];

  const pick = (m: 'all' | 'pick' | 'none') => {
    setWantPick(m === 'pick');
    if (m === 'all') return onChange('all');
    if (m === 'none') return onChange('none');
    onChange(Array.isArray(value) ? value : []);
  };
  const toggle = (id: string) => {
    const next = new Set(selected);
    next.has(id) ? next.delete(id) : next.add(id);
    onChange([...next]);
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          options={[
            { value: 'all', label: 'All' },
            { value: 'pick', label: 'Pick' },
            { value: 'none', label: 'None' },
          ]}
          value={effectiveMode}
          onChange={(m) => m && pick(m)}
        />
        {effectiveMode === 'all' && (
          <span className="text-muted-foreground/60 text-[11px]">{allLabel}</span>
        )}
        {effectiveMode === 'none' && (
          <span className="text-muted-foreground/60 text-[11px]">Deny — nothing granted.</span>
        )}
      </div>
      {effectiveMode === 'pick' &&
        (rows.length === 0 ? (
          <p className="text-muted-foreground/60 text-[11px]">{emptyLabel}</p>
        ) : (
          <div className="border-border/60 max-h-40 overflow-y-auto rounded-md border p-1">
            {rows.map((o) => {
              const isSel = selected.has(o.id);
              const isOrphan = !optionIds.has(o.id);
              return (
                <button
                  key={o.id}
                  type="button"
                  aria-pressed={isSel}
                  onClick={() => toggle(o.id)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs transition-[color,background-color,transform] active:scale-[0.96]',
                    isSel ? 'bg-secondary' : 'hover:bg-muted/50',
                  )}
                >
                  <span
                    className={cn(
                      'flex size-3.5 shrink-0 items-center justify-center rounded-[4px] border text-[9px]',
                      isSel ? 'border-foreground bg-foreground text-background' : 'border-border/70',
                    )}
                  >
                    {isSel ? '✓' : ''}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono">{o.label}</span>
                  {isOrphan && <span className="text-kortix-orange">missing</span>}
                </button>
              );
            })}
          </div>
        ))}
    </div>
  );
}

/** All · Pick · None over the grouped grantable CLI action catalog. */
function KortixCliField({
  value,
  onChange,
}: {
  value: AgentGrantSetV2 | undefined;
  onChange: (v: AgentGrantSetV2) => void;
}) {
  const mode: 'all' | 'pick' | 'none' =
    value === 'all' ? 'all' : value === 'none' || value === undefined ? 'none' : 'pick';
  const [wantPick, setWantPick] = useState(Array.isArray(value) && value.length > 0);
  const effectiveMode = value === 'all' ? 'all' : Array.isArray(value) && (value.length > 0 || wantPick) ? 'pick' : mode;
  const selected = new Set(Array.isArray(value) ? value : []);

  const pick = (m: 'all' | 'pick' | 'none') => {
    setWantPick(m === 'pick');
    if (m === 'all') return onChange('all');
    if (m === 'none') return onChange('none');
    onChange(Array.isArray(value) ? value : []);
  };
  const toggle = (action: string) => {
    const next = new Set(selected);
    next.has(action) ? next.delete(action) : next.add(action);
    onChange([...next]);
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          options={[
            { value: 'all', label: 'All' },
            { value: 'pick', label: 'Pick' },
            { value: 'none', label: 'None' },
          ]}
          value={effectiveMode}
          onChange={(m) => m && pick(m)}
        />
        {effectiveMode === 'all' && (
          <span className="text-muted-foreground/60 text-[11px]">
            Every Kortix-CLI power the launcher holds.
          </span>
        )}
        {effectiveMode === 'none' && (
          <span className="text-muted-foreground/60 text-[11px]">No Kortix-CLI powers.</span>
        )}
      </div>
      {effectiveMode === 'pick' && (
        <div className="border-border/60 max-h-56 space-y-2 overflow-y-auto rounded-md border p-2">
          {KORTIX_CLI_CATALOG.map((grp) => (
            <div key={grp.group} className="space-y-1">
              <p className="text-muted-foreground/70 text-[10px] font-medium tracking-wide uppercase">
                {grp.group}
              </p>
              <div className="flex flex-wrap gap-1">
                {grp.actions.map((action) => {
                  const isSel = selected.has(action);
                  return (
                    <button
                      key={action}
                      type="button"
                      aria-pressed={isSel}
                      onClick={() => toggle(action)}
                      className={cn(
                        'rounded px-1.5 py-1 font-mono text-[11px] transition-[color,background-color,transform] active:scale-[0.96]',
                        isSel
                          ? 'bg-foreground text-background'
                          : 'bg-muted/40 text-muted-foreground hover:bg-muted',
                      )}
                    >
                      {action.replace(/^project\./, '')}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Permission tree editor ────────────────────────────────────────────────

type PermObject = Record<string, PermissionRule | PermissionAction | undefined>;

function asPermObject(permission: PermissionConfig | undefined): PermObject {
  if (permission && typeof permission === 'object') return { ...(permission as PermObject) };
  return {};
}

/** One action-typed key: a bare allow/ask/deny/inherit, plus expandable
 *  glob-pattern → action rules. */
function PermissionRuleRow({
  label,
  rule,
  onChange,
}: {
  label: string;
  rule: PermissionRule | PermissionAction | undefined;
  onChange: (next: PermissionRule | undefined) => void;
}) {
  const isMap = rule !== undefined && typeof rule === 'object';
  const bare = typeof rule === 'string' ? (rule as PermissionAction) : undefined;
  const map = isMap ? (rule as Record<string, PermissionAction>) : {};
  const [showRules, setShowRules] = useState(isMap);

  const setBare = (v: PermissionAction | undefined) => onChange(v);
  const setRuleEntry = (pattern: string, action: PermissionAction) =>
    onChange({ ...map, [pattern]: action });
  const removeRuleEntry = (pattern: string) => {
    const next = { ...map };
    delete next[pattern];
    onChange(Object.keys(next).length ? next : undefined);
  };
  const addRule = () => {
    setShowRules(true);
    onChange({ ...map, '': 'deny' });
  };
  const renameRule = (from: string, to: string) => {
    if (from === to) return;
    const next: Record<string, PermissionAction> = {};
    for (const [k, v] of Object.entries(map)) next[k === from ? to : k] = v;
    onChange(next);
  };

  return (
    <div className="space-y-2 px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <Hint label={PERMISSION_KEY_HELP[label] ?? label} side="top">
          <span className="font-mono text-xs cursor-default">{label}</span>
        </Hint>
        <div className="flex items-center gap-1.5">
          <Segmented
            options={[
              { value: 'allow', label: 'Allow' },
              { value: 'ask', label: 'Ask' },
              { value: 'deny', label: 'Deny' },
            ]}
            value={isMap ? undefined : bare}
            onChange={(v) => setBare(v)}
            allowUnset
          />
          <Hint label="Per-pattern rules">
            <Button
              type="button"
              variant={isMap || showRules ? 'secondary' : 'outline'}
              size="icon"
              className="size-7"
              onClick={() => (showRules ? setShowRules(false) : addRule())}
            >
              <Sliders className="size-3.5 shrink-0" />
            </Button>
          </Hint>
        </div>
      </div>
      <AnimatePresence initial={false}>
        {(showRules || isMap) && (
          <motion.div
            key="rules"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ type: 'spring', duration: 0.3, bounce: 0 }}
            className="overflow-hidden"
          >
            <div className="bg-muted/40 space-y-1.5 rounded-md p-2">
              {Object.entries(map).map(([pattern, action], i) => (
                <div key={`${i}-${pattern}`} className="flex items-center gap-1.5">
                  <Input
                    value={pattern}
                    placeholder="glob e.g. git push"
                    variant="popover"
                    className="h-7 flex-1 font-mono text-xs"
                    onChange={(e) => renameRule(pattern, e.target.value)}
                  />
                  <Segmented
                    options={[
                      { value: 'allow', label: 'Allow' },
                      { value: 'ask', label: 'Ask' },
                      { value: 'deny', label: 'Deny' },
                    ]}
                    value={action}
                    onChange={(v) => v && setRuleEntry(pattern, v)}
                  />
                  <Hint label="Remove rule">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-7"
                      onClick={() => removeRuleEntry(pattern)}
                    >
                      <Trash2 className="size-3.5 shrink-0" />
                    </Button>
                  </Hint>
                </div>
              ))}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 gap-1 px-2 text-xs"
                onClick={addRule}
              >
                <Plus className="size-3 shrink-0" /> Add pattern rule
              </Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function PermissionEditor({
  permission,
  onChange,
}: {
  permission: PermissionConfig | undefined;
  onChange: (next: PermissionConfig | undefined) => void;
}) {
  const obj = asPermObject(permission);
  const bareDefault = typeof permission === 'string' ? (permission as PermissionAction) : undefined;
  const allKeys = [...PERMISSION_RULE_KEYS, ...PERMISSION_ACTION_ONLY_KEYS];

  const setDefault = (v: PermissionAction | undefined) => onChange(v);
  const setKey = (key: string, value: PermissionRule | PermissionAction | undefined) => {
    const base: PermObject = bareDefault
      ? (Object.fromEntries(allKeys.map((k) => [k, bareDefault])) as PermObject)
      : obj;
    const next: PermObject = { ...base };
    if (value === undefined) delete next[key];
    else next[key] = value;
    onChange(Object.keys(next).length ? (next as PermissionConfig) : undefined);
  };

  return (
    <div className="space-y-4">
      <p className="text-muted-foreground/70 text-[11px] leading-relaxed text-pretty">
        Allow runs freely, Ask pauses for human approval, Deny blocks it outright. Set a default for
        every capability below, or leave it unset and tune specific ones. The sliders control adds
        glob-pattern rules (e.g. <span className="font-mono">git push</span> → Deny while everything
        else stays Allow).
      </p>

      <div className="bg-popover flex flex-wrap items-center justify-between gap-3 rounded-md border px-3 py-2.5">
        <div className="min-w-0">
          <p className="text-foreground/80 text-xs font-medium">Default for every capability</p>
          <p className="text-muted-foreground/60 text-[11px]">
            {bareDefault
              ? 'Applies to every capability below until you override one.'
              : 'Unset — each capability inherits the runtime default.'}
          </p>
        </div>
        <Segmented
          options={[
            { value: 'allow', label: 'Allow' },
            { value: 'ask', label: 'Ask' },
            { value: 'deny', label: 'Deny' },
          ]}
          value={bareDefault}
          onChange={setDefault}
          allowUnset
        />
      </div>

      {PERMISSION_RULE_GROUPS.map((group) => (
        <div key={group.label} className="space-y-1.5">
          <p className="text-muted-foreground/70 text-[10px] font-medium tracking-wide uppercase">
            {group.label}
          </p>
          <div className="bg-popover divide-border/60 divide-y rounded-md border">
            {group.keys.map((key) => (
              <PermissionRuleRow
                key={key}
                label={key}
                rule={obj[key]}
                onChange={(next) => setKey(key, next)}
              />
            ))}
          </div>
        </div>
      ))}

      <div className="space-y-1.5">
        <p className="text-muted-foreground/70 text-[10px] font-medium tracking-wide uppercase">
          Action-only
        </p>
        <div className="bg-popover divide-border/60 divide-y rounded-md border">
          {PERMISSION_ACTION_ONLY_KEYS.map((key) => (
            <div key={key} className="flex items-center justify-between gap-2 px-3 py-2.5">
              <Hint label={PERMISSION_KEY_HELP[key] ?? key} side="top">
                <span className="font-mono text-xs cursor-default">{key}</span>
              </Hint>
              <Segmented
                options={[
                  { value: 'allow', label: 'Allow' },
                  { value: 'ask', label: 'Ask' },
                  { value: 'deny', label: 'Deny' },
                ]}
                value={typeof obj[key] === 'string' ? (obj[key] as PermissionAction) : undefined}
                onChange={(v) => setKey(key, v)}
                allowUnset
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── The editor modal ──────────────────────────────────────────────────────

type Agent = ProjectConfigSummary['agents'][number];

function SectionHeader({ icon: Icon, title }: { icon: typeof Bot; title: string }) {
  return (
    <div className="flex items-center gap-2">
      <Icon className="text-muted-foreground/70 size-3.5 shrink-0" />
      <span className="text-foreground/80 text-xs font-medium tracking-wide uppercase">{title}</span>
    </div>
  );
}

/**
 * The top-level layer divider — makes the Kortix/OpenCode split visually
 * unmistakable (spec §2.2 structural refactor: "Kortix concerns and OpenCode
 * concerns are 100% distinct"). Each layer's fields sit in their own labeled
 * group below this header.
 */
function LayerHeader({
  label,
  tone,
  description,
  icon: Icon,
}: {
  label: string;
  tone: 'kortix' | 'outline';
  description: string;
  icon: typeof Bot;
}) {
  return (
    <div className="flex items-center gap-2.5 border-b border-border/60 pb-2.5">
      <span
        className={cn(
          'flex size-6 shrink-0 items-center justify-center rounded-sm',
          tone === 'kortix' ? 'bg-kortix-base/20' : 'bg-muted',
        )}
      >
        <Icon className={cn('size-3.5', tone === 'kortix' ? 'text-foreground' : 'text-muted-foreground')} />
      </span>
      <Badge variant={tone} size="sm" className="shrink-0 tracking-wide uppercase">
        {label}
      </Badge>
      <p className="text-muted-foreground/70 min-w-0 text-[11px] leading-relaxed text-pretty">
        {description}
      </p>
    </div>
  );
}

function AgentEditorModal({
  projectId,
  agentName,
  initial,
  skillsOptions,
  open,
  onOpenChange,
}: {
  projectId: string;
  agentName: string;
  initial: AgentConfigBlock;
  skillsOptions: { id: string; label: string }[];
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const [draft, setDraft] = useState<AgentConfigBlock>(initial);
  const [baseline] = useState<AgentConfigBlock>(initial);
  const isDirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(baseline), [draft, baseline]);
  const update = useUpdateAgentConfig(projectId, agentName);
  const { data: providers } = useOpenCodeProviders();
  const models = useMemo(() => flattenModels(providers), [providers]);

  const secretsQuery = useQuery({
    queryKey: ['project-secrets', projectId],
    queryFn: () => listProjectSecrets(projectId),
    staleTime: 30_000,
  });
  const connectorsQuery = useQuery({
    queryKey: ['project-connectors', projectId],
    queryFn: () => listConnectors(projectId),
    staleTime: 30_000,
  });
  const secretOptions = useMemo(
    () =>
      [...new Set((secretsQuery.data?.items ?? []).map((s) => s.identifier))]
        .sort()
        .map((identifier) => ({ id: identifier, label: identifier })),
    [secretsQuery.data],
  );
  const connectorOptions = useMemo(
    () =>
      (connectorsQuery.data?.connectors ?? [])
        .map((c) => ({ id: c.slug, label: c.name || c.slug }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [connectorsQuery.data],
  );

  // No governance field is a plain string anymore (that was `description`/
  // `model`, both moved to the OpenCode layer) — clearing is undefined-only.
  const set = <K extends keyof AgentConfigBlock>(key: K, value: AgentConfigBlock[K]) =>
    setDraft((d) => {
      const next = { ...d };
      if (value === undefined) delete next[key];
      else next[key] = value;
      return next;
    });

  // OpenCode-layer fields live nested under `draft.opencode` — same
  // clear-on-empty semantics as `set`, folded into the sub-object.
  const setOc = <K extends keyof OpencodeAgentConfig>(key: K, value: OpencodeAgentConfig[K]) =>
    setDraft((d) => {
      const oc: OpencodeAgentConfig = { ...(d.opencode ?? {}) };
      if (value === undefined || value === '') delete oc[key];
      else oc[key] = value;
      const next = { ...d };
      if (Object.keys(oc).length > 0) next.opencode = oc;
      else delete next.opencode;
      return next;
    });

  const oc = draft.opencode ?? {};
  const selectedModelKey = oc.model ? wireToModelKey(oc.model) : null;
  const permCount =
    typeof oc.permission === 'string' ? 1 : oc.permission ? Object.keys(oc.permission).length : 0;

  const onSave = async () => {
    try {
      await update.mutateAsync(draft);
      successToast(`${agentName} configuration saved`);
      onOpenChange(false);
    } catch (e) {
      errorToast((e as Error)?.message ?? 'Failed to save configuration');
    }
  };

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent className="lg:max-w-2xl">
        <ModalHeader>
          <ModalTitle>Configure {agentName}</ModalTitle>
          <ModalDescription>
            The full agent definition. Governance saves to{' '}
            <span className="font-mono">kortix.yaml</span>; behavior saves to this agent's{' '}
            <span className="font-mono">.kortix/opencode/agents/{agentName}.md</span>.
          </ModalDescription>
        </ModalHeader>
        <ModalBody className="max-h-[70vh] space-y-8 overflow-y-auto">
          {/* ─── KORTIX LAYER — identity + governance, runtime-agnostic ─── */}
          <div className="space-y-6">
            <LayerHeader
              icon={Layers}
              label="Kortix"
              tone="kortix"
              description="Identity, model, and platform-enforced governance. Works the same no matter what runtime executes this agent."
            />

            <section className="space-y-4">
              <SectionHeader icon={Bot} title="Identity" />
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-foreground/80 text-xs font-medium">Enabled</p>
                  <p className="text-muted-foreground/60 text-[11px]">
                    Disabled agents can't start sessions.
                  </p>
                </div>
                <Switch
                  checked={draft.enabled !== false}
                  onCheckedChange={(v) => set('enabled', v ? undefined : false)}
                />
              </div>
            </section>

            <section className="space-y-4">
              <SectionHeader icon={ShieldCheck} title="Governance" />
              <p className="text-muted-foreground/60 text-[11px] leading-relaxed text-pretty">
                Enforced platform-side. Deny-by-default: an empty grant means the agent gets nothing
                until you grant it.
              </p>
              <FieldRow label="Skills">
                <GrantSetField
                  value={draft.skills}
                  onChange={(v) => set('skills', v)}
                  options={skillsOptions}
                  allLabel="Every project skill."
                  emptyLabel="No skills declared in this project yet."
                />
              </FieldRow>
              <FieldRow label="Connectors">
                <GrantSetField
                  value={draft.connectors}
                  onChange={(v) => set('connectors', v)}
                  options={connectorOptions}
                  allLabel="Every project connector."
                  emptyLabel="No connectors in this project yet."
                />
              </FieldRow>
              <FieldRow label="Secrets">
                <GrantSetField
                  value={draft.secrets}
                  onChange={(v) => set('secrets', v)}
                  options={secretOptions}
                  allLabel="Every project secret."
                  emptyLabel="No secrets in this project yet."
                />
              </FieldRow>
              <FieldRow label="Kortix CLI">
                <KortixCliField value={draft.kortix_cli} onChange={(v) => set('kortix_cli', v)} />
              </FieldRow>
              <FieldRow label="Workspace" hint="git boundary (enforced in a later phase)">
                <div className="space-y-1.5">
                  <Segmented
                    options={WORKSPACE_MODES.map((m) => ({ value: m, label: m }))}
                    value={draft.workspace}
                    onChange={(v) => set('workspace', v)}
                    allowUnset
                  />
                  <p className="text-muted-foreground/60 text-[11px]">
                    {draft.workspace ? WORKSPACE_MODE_HELP[draft.workspace] : 'Inherits the project default.'}
                  </p>
                </div>
              </FieldRow>
            </section>
          </div>

          {/* ─── OPENCODE LAYER — nested, runtime-specific behavior ─── */}
          <div className="space-y-6">
            <LayerHeader
              icon={Cpu}
              label="OpenCode"
              tone="outline"
              description="Behavior this agent's runtime executes — mode, sampling, permission tree. Namespaced so a future runtime (Codex/Claude) gets its own block here."
            />

            <section className="space-y-4">
              <SectionHeader icon={Gauge} title="Behavior" />
              <FieldRow
                label="Description"
                hint={oc.mode === 'subagent' ? 'required for subagents' : 'shown to other agents when picking a subagent'}
              >
                <Textarea
                  value={oc.description ?? ''}
                  placeholder="What this agent is for"
                  minHeight={44}
                  onChange={(e) => setOc('description', e.target.value)}
                />
              </FieldRow>
              <FieldRow label="Model" hint="declarative default; runtime prefs can override">
                <div className="flex items-center gap-2">
                  <ModelSelector
                    models={models}
                    providers={providers}
                    selectedModel={selectedModelKey}
                    onSelect={(m) => setOc('model', m ? modelKeyToWire(m) : undefined)}
                  />
                  {oc.model ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs"
                      onClick={() => setOc('model', undefined)}
                    >
                      Clear
                    </Button>
                  ) : null}
                </div>
              </FieldRow>
              <FieldRow label="Mode">
                <div className="space-y-1.5">
                  <Segmented
                    options={AGENT_MODES.map((m) => ({ value: m, label: m }))}
                    value={oc.mode}
                    onChange={(v) => setOc('mode', v)}
                    allowUnset
                  />
                  <p className="text-muted-foreground/60 text-[11px]">
                    {oc.mode ? AGENT_MODE_HELP[oc.mode] : 'Inherits the project default.'}
                  </p>
                </div>
              </FieldRow>
              <FieldRow label="Variant" hint="optional model variant">
                <Input
                  value={oc.variant ?? ''}
                  placeholder="e.g. thinking"
                  variant="popover"
                  className="h-8 max-w-[240px] text-xs"
                  onChange={(e) => setOc('variant', e.target.value)}
                />
              </FieldRow>
              <FieldRow
                label={
                  <>
                    Temperature
                    {oc.temperature !== undefined ? (
                      <span className="tabular-nums"> — {oc.temperature}</span>
                    ) : null}
                  </>
                }
                hint="0 = deterministic, 2 = most random"
              >
                <div className="flex items-center gap-3">
                  <Slider
                    value={[oc.temperature ?? 0]}
                    min={0}
                    max={2}
                    step={0.05}
                    className="max-w-[240px]"
                    onValueChange={([v]) => setOc('temperature', v)}
                  />
                  {oc.temperature !== undefined ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-xs"
                      onClick={() => setOc('temperature', undefined)}
                    >
                      Reset
                    </Button>
                  ) : null}
                </div>
              </FieldRow>
              <FieldRow
                label={
                  <>
                    Top-p
                    {oc.top_p !== undefined ? <span className="tabular-nums"> — {oc.top_p}</span> : null}
                  </>
                }
                hint="nucleus sampling cutoff; leave at 1 unless tuning"
              >
                <div className="flex items-center gap-3">
                  <Slider
                    value={[oc.top_p ?? 1]}
                    min={0}
                    max={1}
                    step={0.01}
                    className="max-w-[240px]"
                    onValueChange={([v]) => setOc('top_p', v)}
                  />
                  {oc.top_p !== undefined ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-xs"
                      onClick={() => setOc('top_p', undefined)}
                    >
                      Reset
                    </Button>
                  ) : null}
                </div>
              </FieldRow>
              <FieldRow label="Steps" hint="max agent steps per run">
                <Input
                  type="number"
                  min={1}
                  value={oc.steps ?? ''}
                  placeholder="unset"
                  variant="popover"
                  className="h-8 max-w-[140px] text-xs"
                  onChange={(e) =>
                    setOc('steps', e.target.value ? Math.max(1, Number(e.target.value)) : undefined)
                  }
                />
              </FieldRow>
              <FieldRow label="Color" hint="tints this agent's badge across pickers and session UI">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="flex flex-wrap gap-1">
                    {THEME_COLORS.map((c) => {
                      const active = oc.color === c;
                      return (
                        <button
                          key={c}
                          type="button"
                          onClick={() => setOc('color', active ? undefined : c)}
                          className={cn(
                            'rounded-full border px-2 py-1 text-[11px] capitalize transition-[color,background-color,transform] active:scale-[0.96]',
                            active
                              ? 'border-foreground bg-foreground text-background'
                              : 'border-border/70 text-muted-foreground hover:bg-muted/50',
                          )}
                        >
                          {c}
                        </button>
                      );
                    })}
                  </div>
                  <Hint label="Custom hex color">
                    <input
                      type="color"
                      value={/^#[0-9a-fA-F]{6}$/.test(oc.color ?? '') ? oc.color : '#7c5cff'}
                      onChange={(e) => setOc('color', e.target.value)}
                      className="border-border/70 size-7 shrink-0 cursor-pointer rounded-full border bg-transparent transition-transform active:scale-[0.96]"
                      aria-label="Custom hex color"
                    />
                  </Hint>
                  {oc.color ? (
                    <Badge variant="outline" size="xs" className="font-mono">
                      {oc.color}
                    </Badge>
                  ) : null}
                </div>
              </FieldRow>
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-foreground/80 text-xs font-medium">Hidden</p>
                  <p className="text-muted-foreground/60 text-[11px]">
                    Keep this agent out of pickers.
                  </p>
                </div>
                <Switch checked={!!oc.hidden} onCheckedChange={(v) => setOc('hidden', v || undefined)} />
              </div>
              <FieldRow
                label="System prompt"
                hint={`saved to .kortix/opencode/agents/${agentName}.md`}
              >
                <Textarea
                  value={oc.prompt ?? ''}
                  placeholder="You are..."
                  minHeight={160}
                  className="font-mono text-xs"
                  onChange={(e) => setOc('prompt', e.target.value)}
                />
              </FieldRow>
            </section>

            {/* PERMISSIONS (advanced) */}
            <section>
              <Disclosure variant="outline" className="overflow-hidden rounded-md">
                <DisclosureTrigger variant="outline">
                  <Button
                    variant="popover"
                    className="flex w-full items-center justify-start gap-2 rounded-none"
                  >
                    <Sliders className="text-muted-foreground/70 size-3.5 shrink-0" />
                    <span className="text-xs font-medium">Advanced — permission tree</span>
                    {permCount > 0 ? (
                      <Badge variant="muted" size="xs" className="ml-auto">
                        {permCount} customized
                      </Badge>
                    ) : null}
                  </Button>
                </DisclosureTrigger>
                <DisclosureContent variant="outline" contentClassName="border-border border-t">
                  <div className="px-3 py-3">
                    <PermissionEditor
                      permission={oc.permission}
                      onChange={(next) => setOc('permission', next)}
                    />
                  </div>
                </DisclosureContent>
              </Disclosure>
            </section>
          </div>
        </ModalBody>
        <ModalFooter className="sm:justify-between">
          <div className="flex items-center gap-2.5">
            <Button type="button" variant="outline-ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <AnimatePresence initial={false}>
              {isDirty ? (
                <motion.span
                  key="dirty"
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 4 }}
                  transition={{ type: 'spring', duration: 0.3, bounce: 0 }}
                  className="text-muted-foreground/60 text-[11px]"
                >
                  Unsaved changes
                </motion.span>
              ) : null}
            </AnimatePresence>
          </div>
          <Button type="button" onClick={onSave} disabled={update.isPending || !isDirty}>
            {update.isPending ? <Loading className="size-4 shrink-0" /> : null}
            Save configuration
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

// ─── Public entry — mounted from agents-view's detail aside ────────────────

/** Summarize a grant set for the compact card. */
export function grantSummary(v: AgentGrantSetV2 | undefined): {
  label: string;
  tone: 'muted' | 'outline';
} {
  if (v === 'all') return { label: 'All', tone: 'outline' };
  if (v === undefined || v === 'none' || (Array.isArray(v) && v.length === 0))
    return { label: 'None', tone: 'muted' };
  return { label: `${(v as string[]).length} picked`, tone: 'outline' };
}

export function AgentConfigEditor({
  projectId,
  agent,
  skillsOptions,
  fallback,
}: {
  projectId: string;
  agent: Agent;
  /** The project's declared skills, for the governance picker. */
  skillsOptions: { id: string; label: string }[];
  /** Rendered for a v1 project (the legacy model + scope cards) — we degrade. */
  fallback: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const configQuery = useAgentConfig(projectId, agent.name);

  if (configQuery.isLoading) {
    return (
      <div className="border-border/60 bg-muted/20 space-y-2.5 rounded-lg border p-4">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }

  // Read failed (e.g. 403 for a non-manager) or unexpected — fall back to the
  // legacy cards, never blank the panel.
  const data = configQuery.data;
  if (!data) return <>{fallback}</>;

  // v1 project → degrade to the legacy editor + an upgrade hint.
  if (!data.editable) {
    return (
      <div className="space-y-3">
        {fallback}
        <InfoBanner tone="info" title="Upgrade for the full agent editor">
          This project uses a v1 manifest. Migrate to <span className="font-mono">kortix.yaml</span>{' '}
          (kortix_version 2) to edit the agent's mode, model, temperature, permission tree, and
          per-agent governance here.
        </InfoBanner>
      </div>
    );
  }

  const block = data.block ?? {};
  const summaries: { key: string; label: string; grant: AgentGrantSetV2 | undefined }[] = [
    { key: 'skills', label: 'Skills', grant: block.skills },
    { key: 'connectors', label: 'Connectors', grant: block.connectors },
    { key: 'secrets', label: 'Secrets', grant: block.secrets },
    { key: 'kortix_cli', label: 'CLI', grant: block.kortix_cli },
  ];

  return (
    <div className="border-border/60 bg-muted/20 space-y-3 rounded-lg border p-4">
      <div className="flex items-center justify-between gap-2">
        <SectionHeader icon={Bot} title="Configuration" />
        <Badge variant="muted" size="xs" className="font-mono">
          yaml + .md
        </Badge>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {block.opencode?.mode ? (
          <Badge variant="outline" size="xs" className="capitalize">
            {block.opencode.mode}
          </Badge>
        ) : null}
        {block.opencode?.model ? (
          <Badge variant="outline" size="xs" className="font-mono">
            {block.opencode.model}
          </Badge>
        ) : null}
        {block.opencode?.temperature !== undefined ? (
          <Badge variant="outline" size="xs">
            temp {block.opencode.temperature}
          </Badge>
        ) : null}
        {block.opencode?.hidden ? (
          <Badge variant="muted" size="xs">
            hidden
          </Badge>
        ) : null}
        {block.enabled === false ? (
          <Badge variant="muted" size="xs">
            disabled
          </Badge>
        ) : null}
      </div>

      <div className="space-y-1.5">
        {summaries.map((s) => {
          const sum = grantSummary(s.grant);
          return (
            <div key={s.key} className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground/70 text-[11px] font-medium tracking-wide uppercase">
                {s.label}
              </span>
              <Badge variant={sum.tone} size="xs">
                {sum.label}
              </Badge>
            </div>
          );
        })}
      </div>

      <Button size="sm" className="w-full" onClick={() => setOpen(true)}>
        Edit configuration
      </Button>

      {open ? (
        <AgentEditorModal
          projectId={projectId}
          agentName={agent.name}
          initial={block}
          skillsOptions={skillsOptions}
          open={open}
          onOpenChange={setOpen}
        />
      ) : null}
    </div>
  );
}
