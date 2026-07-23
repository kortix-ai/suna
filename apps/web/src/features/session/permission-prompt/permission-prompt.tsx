'use client';

/**
 * ONE on-system permission surface (Task WS5-P1-c) — collapses the two
 * "amber twin" prompts that used to stack above the composer:
 *
 *  - `AcpSessionPermissionPrompt` (deleted as a standalone implementation,
 *    now a re-export of this component): the ACP wire-level tool permission
 *    card (`session/request_permission`), answered through `onReply`.
 *  - `SessionApprovalPrompt` (same): the project connector "requires
 *    approval" card, answered through `useResolveApproval`.
 *
 * Both domains render as rows in the SAME design-system container
 * (`bg-popover rounded-md border` — no `amber-*`, ever). They stay two
 * genuinely different backends under the hood (an ACP permission is
 * answered by resuming a blocked JSON-RPC call; a connector action is
 * answered by a REST mutation against the session audit trail) — this
 * component is the seam that makes them look and behave like one surface,
 * not a rewrite of either backend.
 *
 * ─── The interaction contract (rewritten for non-technical users) ───
 *
 * A permission request is a BINARY question, so every row answers it with
 * exactly two buttons — "Skip" and "Run"/"Allow" — beside ONE dropdown that
 * chooses how long the answer lasts:
 *
 *   [ Just once ⌄ ]                              [ Skip ]  [ Run ]
 *
 * The menu is the `ApprovalScope` axis (see that type for the full mapping):
 * once / this session / always in this project, each naming the scope it
 * grants ("All commands", "All file edits", "All mkdir") rather than leaving
 * the user to guess how wide "again" is.
 *
 * Its six entries are not new powers — they are the powers the two prompts
 * this component replaced ALREADY had, plus two that shipped in
 * `usePermissionPolicy` with no control anywhere. A brief intermediate
 * version of this file collapsed all of it into a single "don't ask again"
 * CHECKBOX, which is a one-bit control over a six-valued axis: four
 * durations became unreachable. That was a lossy merge wearing a
 * simplification's clothes, and the menu undoes it.
 *
 * Two rules hold across every scope (enforced once, in `replyAcp`):
 *   1. The CURRENT request is always answered, even when the chosen scope
 *      would not itself have covered it.
 *   2. Persistent state is written only AFTER the reply resolves.
 * And Skip is always once-only — the menu scopes the ALLOW, so "block
 * everything forever" is never two clicks from "allow everything forever".
 *
 * Persistence per domain (unchanged backends, one shared control):
 *  - ACP rows          → `usePermissionPolicy().rememberToolDecision(key, 'allow')`
 *                        (project-scoped `toolDecisions`) and/or
 *                        `setAutoApprove('reads' | 'all')`, keyed by
 *                        `policyKeyFor` — NOT the raw permission string,
 *                        which for a title-reporting harness is a one-off
 *                        that could never match twice. Plus the harness's own
 *                        `allow_always` option when it offers one, so the
 *                        session stops asking too.
 *  - Connector rows    → the audit mutation's own `once`/`session`/
 *                        `session_all` scopes, plus `setProjectPolicies`
 *                        `always_run` on the qualified `slug.tool` match,
 *                        gated on `PROJECT_CONNECTOR_WRITE` — if the member
 *                        can't write policies, that tier isn't offered.
 *
 * The whole card is retired by `acp-session-chat.tsx` when the session hits a
 * terminal error: `onReply` resumes a blocked JSON-RPC call, so with the
 * connection gone every button here could only fail.
 *
 * Persistent policy (Task WS5-P1-a/b, `usePermissionPolicy`) layers ONLY on
 * top of the ACP side, through the exact same `onReply` respond path the
 * manual buttons use (mirroring the session-scoped auto-approve backstop
 * already in `useAcpSession` — see that file's `autoApprovePermissions`
 * effect): `autoApprove: 'reads'` auto-answers read-only ACP kinds,
 * `autoApprove: 'all'` auto-answers everything, and a remembered
 * `toolDecisions[tool]` auto-answers (allow OR deny) that exact tool on
 * every future request. `usePermissionPolicy` defaults to
 * `{autoApprove:'none', toolDecisions:{}}` while its query is loading, so
 * nothing is ever auto-answered before the real policy is known
 * (deny-by-default, per that hook's own contract).
 */

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import Hint from '@/components/ui/hint';
import Loading from '@/components/ui/loading';
import { errorToast } from '@/components/ui/toast';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';
import { cn } from '@/lib/utils';
import { PERMISSION_LABELS } from '@/ui/types';
import {
  resolvePermissionActionOptions,
  type AcpJsonRpcId,
  type AcpPendingOption,
  type AcpPendingPermission,
} from '@kortix/sdk';
import {
  listProjectPolicies,
  setProjectPolicies,
  type PolicyAction,
  type SessionAuditAction,
} from '@kortix/sdk/projects-client';
import { usePermissionPolicy } from '@kortix/sdk/react';
import { Check, ChevronDown, Ellipsis, ShieldQuestion, X } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  isPendingAction,
  riskTone,
  useResolveApproval,
  useSessionAudit,
} from '../session-audit-shared';

/** ACP permission `kind`s that never mutate the sandbox — the only kinds a
 *  project policy's `autoApprove: 'reads'` is allowed to wave through.
 *  Deliberately excludes `mcp` (arbitrary third-party tool, no way to know
 *  its side effects) and `doom_loop` (a repeat-detection warning, never a
 *  routine read).
 *
 *  Deliberately excludes `webfetch` too (WS5-P1-c review, Important #2):
 *  network egress is an SSRF/exfiltration axis, not a local read — a
 *  "reads-only" auto-approve should not silently let a session make
 *  outbound requests on the user's behalf. The repo's own tool taxonomy
 *  (`apps/web/src/ui/types.ts`'s `PERMISSION_LABELS`, `packages/sdk`'s
 *  `turns/tool-registry.ts`) already keeps `webfetch` as its own category,
 *  separate from `read`/`list`/`glob`/`grep`. Widening this set back to
 *  include `webfetch` is a deliberate PRODUCT decision, not a bug fix — see
 *  "Open decisions" #-1 in `docs/superpowers/plans/2026-07-15-cortex-cycle-progress.md`
 *  (Jay: keep narrow vs. widen with UI copy disclosure). Do not re-add it
 *  here without that decision being made explicitly. */
const READ_ONLY_PERMISSION_KINDS = new Set(['read']);

/** How long an answered row stays visible as a compact record before the
 *  container quietly drops it — long enough to register as feedback, short
 *  enough not to accumulate clutter across a long session. */
const RECORD_ROW_VISIBLE_MS = 2_200;

/** Effective hit-area expansion for the compact `size="sm"` action buttons
 *  this surface uses ("Don't allow" / "Allow" / the extra-options menu) — an
 *  invisible `after:` pseudo-element widens the clickable region without
 *  changing the visible button size. */
const ACTION_BUTTON_CLASS = 'relative after:absolute after:-inset-1 active:scale-[0.96]';

/** Per ACP permission kind: the plain-language, verb-first question ("what is
 *  the agent about to DO"), and the noun that completes "Don't ask again for
 *  ___ in this project" — the scope the user is actually granting, named out
 *  loud instead of left to be guessed.
 *
 *  Keyed by the LOWERCASED kind: harnesses are inconsistent about casing
 *  (OpenCode sends `Bash`, others `bash`), and a user should never see a raw
 *  identifier just because a harness shouted it. */
const PERMISSION_KINDS: Record<string, { title: string; scope: string; isCommand?: boolean }> = {
  bash: { title: 'Run a command', scope: 'commands', isCommand: true },
  execute: { title: 'Run a command', scope: 'commands', isCommand: true },
  edit: { title: 'Edit a file', scope: 'file edits' },
  write: { title: 'Create a file', scope: 'new files' },
  read: { title: 'Read a file', scope: 'file reads' },
  webfetch: { title: 'Open a web page', scope: 'web requests' },
  mcp: { title: 'Use a connected tool', scope: 'tool calls' },
  doom_loop: { title: 'Repeat the same action', scope: 'repeat requests' },
};

/** The `toolDecisions` key a remembered decision is stored under.
 *
 *  `@kortix/sdk`'s `acp/reduce.ts` resolves `permission.permission` through a
 *  fallback chain — `params.permission ?? params.title ?? params.name ??
 *  toolCall.title ?? toolCall.kind ?? params.kind ?? method`. `params.title`
 *  outranks `toolCall.kind`, so a harness that TITLES its requests (OpenCode
 *  does) puts the entire invocation in that field:
 *  `mkdir -p /workspace/jay-suthar-portfolio/assets`.
 *
 *  Stored verbatim, that key can never match a second request — "don't ask
 *  again" would be a control that provably does nothing while quietly
 *  polluting the project policy. So the key is the FIRST TOKEN, lowercased:
 *  `Bash` → `bash`, `mkdir -p …` → `mkdir`. A single-token kind is
 *  unchanged apart from case, and a titled command collapses to the command
 *  NAME, which is the granularity a user means by "don't ask me about mkdir
 *  again" — and the same granularity a `bash`-reporting harness already
 *  gives them. */
export function policyKeyFor(rawPermission: string): string {
  const trimmed = rawPermission.trim();
  return (trimmed.split(/\s+/)[0] || trimmed).toLowerCase();
}

/** Reads a remembered decision back, tolerating every shape the key may have
 *  been written in: the RAW string (what shipped before `policyKeyFor`
 *  existed — those rows must keep working), its lowercase form, and the
 *  canonical first-token key. */
export function rememberedDecision(
  toolDecisions: Record<string, 'allow' | 'deny'>,
  rawPermission: string,
): 'allow' | 'deny' | undefined {
  return (
    toolDecisions[rawPermission] ??
    toolDecisions[rawPermission.toLowerCase()] ??
    toolDecisions[policyKeyFor(rawPermission)]
  );
}

/** Whether the PROJECT policy already answers this request, and how.
 *
 *  Extracted so the auto-answer effect and the render path cannot disagree.
 *  They used to: the effect answered asynchronously while the row rendered as
 *  a normal pending prompt, so an already-decided request flashed Skip/Run
 *  buttons for the length of one round trip and then vanished. A decision the
 *  user already made must not be re-asked, not even for 200ms.
 *
 *  A remembered `toolDecisions` entry wins over `autoApprove`; `'all'` waves
 *  through everything; `'reads'` only waves through read-only kinds, matched
 *  on the CANONICAL key so a harness that titles its reads (`read
 *  src/index.ts`) is covered too. */
export function policyDecisionFor(
  policy: { autoApprove: string; toolDecisions: Record<string, 'allow' | 'deny'> },
  rawPermission: string,
): 'allow' | 'deny' | null {
  const remembered = rememberedDecision(policy.toolDecisions, rawPermission);
  if (remembered) return remembered;
  if (policy.autoApprove === 'all') return 'allow';
  if (policy.autoApprove === 'reads' && READ_ONLY_PERMISSION_KINDS.has(policyKeyFor(rawPermission)))
    return 'allow';
  return null;
}

export interface PermissionPresentation {
  /** The row's question, already human-readable. */
  label: string;
  /** `label` is the harness's raw invocation, not a tool name — render it as
   *  code, because that is what it is. */
  mono: boolean;
  /** The plural noun the scope menu says "All ___" about. */
  scope: string;
  /** This request executes a shell command, so the command line gets a `$`
   *  prompt marker and its program name is emphasised. Drives the primary
   *  button's verb too: you *run* a command, you *allow* a file read. */
  isCommand: boolean;
}

export function describePermission(permission: AcpPendingPermission): PermissionPresentation {
  const kind = permission.permission;
  const known = PERMISSION_KINDS[kind.toLowerCase()];
  if (known) {
    return { label: known.title, mono: false, scope: known.scope, isCommand: !!known.isCommand };
  }
  // A titled request. Every harness observed doing this (OpenCode) puts a
  // shell invocation here, so it is shown — and treated — as a command, and
  // the menu scopes to the program name.
  if (/\s/.test(kind.trim())) {
    return { label: kind, mono: true, scope: policyKeyFor(kind), isCommand: true };
  }
  const labelled = PERMISSION_LABELS[kind] ?? PERMISSION_LABELS[kind.toLowerCase()];
  return { label: labelled ?? kind, mono: false, scope: policyKeyFor(kind), isCommand: false };
}

// ─── Approval scope: the "how long does this answer last" axis ─────────────
//
// Every value here maps onto a mechanism that ALREADY existed — this menu
// surfaces them, it does not invent them. Verified against the two prompts
// this component replaced (`acp-session-permission-prompt.tsx` and
// `session-approval-prompt.tsx` at `2312edf97^`) plus the policy layer added
// after them:
//
//   once          Deny / Allow once .................. `allow_once`
//   session-tool  "Allow for session" ................ `allow_always` (harness)
//   session-all   "Allow everything" ................. `useAcpSession`'s client backstop
//                                                      / connector `session_all` wildcard
//   project-tool  "Always allow \"slug.tool\"" ........ `toolDecisions[key]`
//                                                      / `setProjectPolicies(always_run)`
//   project-reads (never had UI) .................... `autoApprove: 'reads'`
//   project-all   (never had UI) .................... `autoApprove: 'all'`
export type ApprovalScope =
  'once' | 'session-tool' | 'session-all' | 'project-tool' | 'project-reads' | 'project-all';

/** Scopes that hand over blanket authority and therefore route through
 *  `ConfirmDialog` before they take effect. */
const BLANKET_SCOPES = new Set<ApprovalScope>(['session-all', 'project-all']);

/** How each scope reads back in the answered-record row, so the user can see
 *  what they just granted without reopening the menu. */
const SCOPE_RECORD_SUFFIX: Record<ApprovalScope, string> = {
  once: '',
  'session-tool': ' · this session',
  'session-all': ' · everything this session',
  'project-tool': ' · always in this project',
  'project-reads': ' · reads always allowed here',
  'project-all': ' · everything always allowed here',
};

/** The confirmation a blanket scope has to pass. Spelling out what stops
 *  being asked is the whole job of this copy. */
const BLANKET_CONFIRM: Record<
  string,
  { title: string; description: string; confirmLabel: string }
> = {
  'session-all': {
    title: 'Allow everything for the rest of this session?',
    description:
      "Kortix won't ask again until this session ends — it can run commands, change files, and use connected tools on its own. You can turn this off at any time.",
    confirmLabel: 'Allow everything',
  },
  'project-all': {
    title: 'Always allow everything in this project?',
    description:
      'Kortix will stop asking permission in this project — in this session and every future one, for every member. This is the widest grant available; you can change it later in the project’s permission settings.',
    confirmLabel: 'Always allow everything',
  },
};

/** What the dropdown trigger reads once a scope is chosen — answers "how
 *  long?", which is the only question the control exists to ask. */
function scopeTriggerLabel(scope: ApprovalScope, noun: string): string {
  switch (scope) {
    case 'once':
      return 'Just once';
    case 'session-tool':
      return 'This session';
    case 'session-all':
      return 'Session · everything';
    case 'project-tool':
      return 'This project';
    case 'project-reads':
      return 'Project · reads';
    case 'project-all':
      return 'Project · everything';
    default:
      return noun;
  }
}

function optionValue(option: AcpPendingOption): string {
  return String(option.optionId ?? option.id ?? option.value ?? '');
}

function permissionDetail(permission: AcpPendingPermission): string | null {
  return permission.patterns.length ? permission.patterns.join('  ') : null;
}

/** The fully-qualified tool path project policies match (`slug.path`). The
 *  audit trail already stores the qualified form in `action`; the slug is
 *  only prepended defensively if a row ever carries the relative form. */
function qualifiedConnectorAction(a: SessionAuditAction): string | null {
  if (!a.connector) return null;
  return a.action.startsWith(`${a.connector}.`) ? a.action : `${a.connector}.${a.action}`;
}

/** Row swap animation: pending prompt -> compact answered record. Same
 *  `{duration:0.3, bounce:0}` spring family as `acp-request-cards.tsx`'s
 *  `cardSwapVariants`, but deliberately asymmetric (design law: "exit
 *  subtler than enter") — kept local rather than imported since the two
 *  components' swap semantics genuinely differ (that one swaps a whole
 *  card; this one swaps individual rows inside a shared container). */
export function rowSwapVariants(reduced: boolean) {
  if (reduced) {
    return {
      initial: { opacity: 0 },
      animate: { opacity: 1 },
      exit: { opacity: 0 },
      transition: { type: 'spring' as const, duration: 0.3, bounce: 0 },
    };
  }
  return {
    initial: { opacity: 0, scale: 0.98, filter: 'blur(4px)' },
    animate: { opacity: 1, scale: 1, filter: 'blur(0px)' },
    exit: { opacity: 0, scale: 0.995, filter: 'blur(1.5px)' },
    transition: { type: 'spring' as const, duration: 0.3, bounce: 0 },
  };
}

/** The answered-record row rides the SAME gutter/column split as the header:
 *  a bare `size-4` status glyph in the gutter, label on the text column. The
 *  old tinted `size-8` tile made a resolved row heavier than the live
 *  question above it, which is backwards. */
function RecordRow({
  label,
  tone,
  motionProps,
}: {
  label: string;
  tone: 'positive' | 'negative';
  motionProps: ReturnType<typeof rowSwapVariants>;
}) {
  return (
    <motion.div
      {...motionProps}
      data-testid="permission-record-row"
      className="flex items-center gap-3 py-2"
    >
      {tone === 'negative' ? (
        <X className="text-kortix-red size-4 shrink-0" />
      ) : (
        <Check className="text-kortix-green size-4 shrink-0" />
      )}
      <span className="text-muted-foreground min-w-0 truncate text-xs">{label}</span>
    </motion.div>
  );
}

/** A shell command, rendered the way a terminal renders one: a `$` prompt
 *  marker, then the program name carried at full contrast with its arguments
 *  stepped back. The marker is `select-none` so copying the line yields the
 *  command and not the prompt — the whole point of showing a `$` is that a
 *  reader recognises it without it becoming part of the text. */
function CommandLine({ command, className }: { command: string; className?: string }) {
  const trimmed = command.trim();
  const split = trimmed.indexOf(' ');
  const program = split === -1 ? trimmed : trimmed.slice(0, split);
  const args = split === -1 ? '' : trimmed.slice(split);
  return (
    <code title={trimmed} className={cn('block truncate font-mono', className)}>
      <span className="text-muted-foreground/70 select-none">$&nbsp;</span>
      <span className="text-foreground font-medium">{program}</span>
      {args ? <span className="text-muted-foreground">{args}</span> : null}
    </code>
  );
}

/** The scope control: one dropdown carrying every duration an approval can
 *  have, grouped by how long it lasts. Replaces the single checkbox that
 *  preceded it — a checkbox can express one scope, and this surface has six
 *  (see `ApprovalScope`), four of which shipped in the prompts this component
 *  replaced and were lost when they were merged.
 *
 *  It is a RADIO group, not a list of actions: choosing a scope changes what
 *  the primary button will do, and nothing happens until that button is
 *  pressed. Selecting "Project · everything" from a menu must never itself be
 *  the moment authority is handed over. */
function ScopeMenu({
  value,
  onChange,
  options,
  noun,
  disabled,
}: {
  value: ApprovalScope;
  onChange: (scope: ApprovalScope) => void;
  /** Which scopes this row's backend can actually honour, in menu order.
   *  Connector rows have no `autoApprove` mode, so they offer fewer. */
  options: { group: string; items: { scope: ApprovalScope; label: string }[] }[];
  noun: string;
  disabled: boolean;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="sm"
          variant="ghost"
          disabled={disabled}
          data-testid="permission-scope-trigger"
          aria-label={`Approval scope: ${scopeTriggerLabel(value, noun)}`}
          className="text-muted-foreground hover:text-foreground data-[state=open]:text-foreground -ml-2 gap-1 active:scale-[0.96]"
        >
          <span className="truncate text-xs">{scopeTriggerLabel(value, noun)}</span>
          <ChevronDown className="size-3.5 shrink-0 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-60">
        <DropdownMenuRadioGroup
          value={value}
          onValueChange={(next) => onChange(next as ApprovalScope)}
        >
          {options.map((group, index) => (
            <div key={group.group}>
              {index > 0 ? <DropdownMenuSeparator /> : null}
              <DropdownMenuLabel className="text-muted-foreground px-2 font-normal">
                {group.group}
              </DropdownMenuLabel>
              {group.items.map((item) => (
                <DropdownMenuRadioItem key={item.scope} value={item.scope} className="text-sm">
                  {item.label}
                </DropdownMenuRadioItem>
              ))}
            </div>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** ACP rows reach every scope. `project-reads` and `project-all` are the
 *  `autoApprove` modes that shipped in `usePermissionPolicy` but never had a
 *  control anywhere in the UI until now. */
function acpScopeOptions(noun: string) {
  return [
    { group: 'Allow', items: [{ scope: 'once' as ApprovalScope, label: 'Just this once' }] },
    {
      group: 'For the rest of this session',
      items: [
        { scope: 'session-tool' as ApprovalScope, label: `All ${noun}` },
        { scope: 'session-all' as ApprovalScope, label: 'Everything' },
      ],
    },
    {
      group: 'Always, in this project',
      items: [
        { scope: 'project-tool' as ApprovalScope, label: `All ${noun}` },
        { scope: 'project-reads' as ApprovalScope, label: 'Anything that only reads' },
        { scope: 'project-all' as ApprovalScope, label: 'Everything' },
      ],
    },
  ];
}

/** Connector rows are resolved by the audit-trail mutation, whose scope
 *  vocabulary is `once` / `session` / `session_all`, plus a `always_run`
 *  project policy. There is no connector equivalent of the ACP `autoApprove`
 *  modes, so those two entries are absent rather than inert. */
function connectorScopeOptions(noun: string, canWritePolicies: boolean) {
  const groups = [
    { group: 'Allow', items: [{ scope: 'once' as ApprovalScope, label: 'Just this once' }] },
    {
      group: 'For the rest of this session',
      items: [
        { scope: 'session-tool' as ApprovalScope, label: `All ${noun}` },
        { scope: 'session-all' as ApprovalScope, label: 'Everything' },
      ],
    },
  ];
  if (!canWritePolicies) return groups;
  return [
    ...groups,
    {
      group: 'Always, in this project',
      items: [{ scope: 'project-tool' as ApprovalScope, label: `All ${noun}` }],
    },
  ];
}

/** Shared row chrome for both domains: tinted kind tile, plain-language
 *  title, optional mono detail, then a decision bar. Keeping the two
 *  backends inside one visual grammar is the whole point of this file — a
 *  user should never have to learn that "the amber one" and "the other
 *  amber one" answer differently. */
function DecisionRow({
  title,
  mono,
  isCommand,
  titleSuffix,
  detail,
  scopeControl,
  busyKind,
  disabled,
  onAllow,
  onDeny,
  extraOptions,
  motionProps,
}: {
  title: string;
  /** Render the title as code — it IS code. See `describePermission`. */
  mono?: boolean;
  /** The command line (title when `mono`, else `detail`) gets a `$` prompt
   *  marker, and the primary button says "Run" instead of "Allow". */
  isCommand?: boolean;
  titleSuffix?: ReactNode;
  detail: string | null;
  scopeControl: ReactNode;
  busyKind: 'allow' | 'deny' | null;
  disabled: boolean;
  onAllow: () => void;
  onDeny: () => void;
  extraOptions?: { key: string; label: string; onSelect: () => void }[];
  motionProps: ReturnType<typeof rowSwapVariants>;
}) {
  // "Run" for a shell command, "Allow" for everything else. A file read is
  // not something you run, and a button that says so is a button that has
  // stopped describing its own action.
  const primaryLabel = isCommand ? 'Run' : 'Allow';
  return (
    <motion.div
      {...motionProps}
      role="group"
      aria-label={title}
      data-testid="permission-decision-row"
      // Divider spans the full card; the CONTENT is what sits on the text
      // column, so a stack of requests still reads as one list.
      className="border-border border-b py-3 first:pt-0 last:border-b-0 last:pb-0"
    >
      <div className="flex min-w-0 items-center gap-2">
        {mono ? (
          isCommand ? (
            <CommandLine command={title} className="min-w-0 flex-1 text-sm" />
          ) : (
            <code title={title} className="min-w-0 flex-1 truncate font-mono text-sm">
              {title}
            </code>
          )
        ) : (
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{title}</span>
        )}
        {titleSuffix}
      </div>
      {detail ? (
        isCommand ? (
          <CommandLine command={detail} className="mt-1 text-xs" />
        ) : (
          <code
            title={detail}
            className="text-muted-foreground mt-1 block truncate font-mono text-xs"
          >
            {detail}
          </code>
        )
      ) : null}

      <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-2">
        {scopeControl}
        <div className="ml-auto flex items-center gap-2.5">
          <Button
            size="sm"
            variant="ghost"
            className={cn(
              ACTION_BUTTON_CLASS,
              'hover:border-destructive/30 hover:bg-destructive/10 hover:text-destructive',
            )}
            data-testid="acp-permission-deny"
            // With several requests stacked, "Skip"/"Skip"/"Skip" is useless
            // to a screen reader. The accessible name still CONTAINS the
            // visible label (WCAG 2.5.3 Label in Name), it just says which
            // request it answers.
            aria-label={`Skip — ${title}`}
            disabled={disabled}
            onClick={onDeny}
          >
            {busyKind === 'deny' ? <Loading className="size-3.5 shrink-0" /> : null}
            Skip
          </Button>
          <Button
            size="sm"
            variant="default"
            className={ACTION_BUTTON_CLASS}
            data-testid="acp-permission-allow-once"
            aria-label={`${primaryLabel} — ${title}`}
            disabled={disabled}
            onClick={onAllow}
          >
            {busyKind === 'allow' ? <Loading className="size-3.5 shrink-0" /> : null}
            {primaryLabel}
          </Button>
          {extraOptions?.length ? (
            <DropdownMenu>
              <Hint label="More options">
                <DropdownMenuTrigger asChild>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label="More options"
                    className="relative shrink-0 after:absolute after:-inset-1.5 active:scale-[0.96]"
                    disabled={disabled}
                  >
                    <Ellipsis className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
              </Hint>
              <DropdownMenuContent align="end" className="min-w-48">
                {extraOptions.map((option) => (
                  <DropdownMenuItem key={option.key} onSelect={option.onSelect}>
                    {option.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      </div>
    </motion.div>
  );
}

export interface PermissionPromptProps {
  /** Owns both request domains: the ACP permission-policy backstop
   *  (`usePermissionPolicy`) and the connector-approval audit query
   *  (`useSessionAudit`) are both keyed by project. */
  projectId: string;
  /** The Kortix (route) session id — NOT the runtime/ACP session id — the
   *  same id `useSessionAudit`/`useResolveApproval` key their query on. */
  sessionId: string;
  permissions: AcpPendingPermission[];
  /** Session-scoped client-side "allow everything" backstop, owned by
   *  `useAcpSession` (survives this component remounting). */
  autoApprove: boolean;
  onAutoApproveChange: (value: boolean) => void;
  /** The ACP respond path — every ACP answer in this component (manual
   *  click, "allow everything", or a policy auto-answer) goes through this
   *  SAME function. Never invent a parallel respond. */
  onReply: (id: AcpJsonRpcId, optionId?: string) => Promise<void> | void;
  /** Switch the whole session to its most-permissive advertised mode
   *  (claude → bypassPermissions, codex → agent-full-access). The blanket
   *  "Everything this session" scopes ("Allow all" in the header, and the
   *  per-row `session-all` menu entry) call this so the harness STOPS sending
   *  new `session/request_permission`s — resolving the currently-pending ones
   *  alone doesn't help when the running turn keeps generating more (the "even
   *  when I click Allow everything it doesn't work" bug). The client-side
   *  `onAutoApproveChange` backstop still answers anything that slips through.
   *  Resolves to `true` when a permissive mode was applied, `false` when this
   *  harness advertises none. Optional so a host that can't change mode still
   *  gets a working per-request prompt. */
  onAllowAllMode?: () => Promise<boolean> | boolean | void;
}

export function PermissionPrompt({
  projectId,
  sessionId,
  permissions,
  autoApprove,
  onAutoApproveChange,
  onReply,
  onAllowAllMode,
}: PermissionPromptProps) {
  const reduceMotion = useReducedMotion() ?? false;
  const rowMotion = rowSwapVariants(reduceMotion);

  // `setAutoApprove` backs the two project-wide modes ('reads' / 'all') that
  // have existed in `usePermissionPolicy` since WS5-P1-a but had no control
  // anywhere in the UI until the scope menu.
  const { policy, rememberToolDecision, setAutoApprove } = usePermissionPolicy(projectId);

  const { data: audit } = useSessionAudit(projectId, sessionId, { refetchInterval: 5_000 });
  const resolveConnector = useResolveApproval(projectId, sessionId);
  const canWritePolicies = useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE);
  const pendingConnectorActions = (audit?.actions ?? []).filter(isPendingAction);

  // In-flight keys: `${rowKey}:allow` / `${rowKey}:deny`, or `all` for the
  // bulk action. A SET rather than the old single `busy` string so two rows
  // can be answered concurrently — with several requests stacked, answering
  // one used to freeze every other row's buttons for the whole round trip,
  // which reads as a broken UI. The ACP ids are independent JSON-RPC calls,
  // so there was never a real reason to serialize them.
  const [busyKeys, setBusyKeys] = useState<string[]>([]);
  const isBusy = useCallback((key: string) => busyKeys.includes(key), [busyKeys]);
  const markBusy = useCallback((key: string) => setBusyKeys((keys) => [...keys, key]), []);
  const clearBusy = useCallback(
    (key: string) => setBusyKeys((keys) => keys.filter((k) => k !== key)),
    [],
  );
  const busyKindFor = (rowKey: string): 'allow' | 'deny' | null =>
    isBusy(`${rowKey}:allow`) ? 'allow' : isBusy(`${rowKey}:deny`) ? 'deny' : null;
  const rowDisabled = (rowKey: string) => isBusy('all') || busyKindFor(rowKey) !== null;

  // The chosen approval scope, per row, defaulting to `once`. Local UI state
  // on purpose: picking a scope does nothing until the user presses the
  // primary button, so opening the menu can never be an accidental grant
  // (the `Switch` this lineage started with persisted — and thereby
  // auto-approved — the instant it was flipped).
  const [scopeChoice, setScopeChoice] = useState<Record<string, ApprovalScope>>({});
  const scopeFor = (rowKey: string): ApprovalScope => scopeChoice[rowKey] ?? 'once';
  const setScope = useCallback((rowKey: string, scope: ApprovalScope) => {
    setScopeChoice((current) => ({ ...current, [rowKey]: scope }));
  }, []);

  // The header's bulk "Allow all" (stacked requests only).
  const [confirmAllOpen, setConfirmAllOpen] = useState(false);

  // A blanket scope (`session-all` / `project-all`) is confirmed before it
  // takes effect. `pendingBlanket` holds the row waiting on that answer.
  const [pendingBlanket, setPendingBlanket] = useState<{
    run: () => void;
    scope: ApprovalScope;
  } | null>(null);

  // Transient answered-record rows — keyed by a stable id per resolved
  // request, auto-cleared after `RECORD_ROW_VISIBLE_MS`.
  const [records, setRecords] = useState<
    Record<string, { label: string; tone: 'positive' | 'negative' }>
  >({});
  const recordTimeouts = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const addRecord = useCallback((key: string, label: string, tone: 'positive' | 'negative') => {
    setRecords((current) => ({ ...current, [key]: { label, tone } }));
    const existing = recordTimeouts.current[key];
    if (existing) clearTimeout(existing);
    recordTimeouts.current[key] = setTimeout(() => {
      setRecords((current) => {
        if (!(key in current)) return current;
        const next = { ...current };
        delete next[key];
        return next;
      });
      delete recordTimeouts.current[key];
    }, RECORD_ROW_VISIBLE_MS);
  }, []);

  useEffect(() => {
    const timeouts = recordTimeouts.current;
    return () => {
      for (const t of Object.values(timeouts)) clearTimeout(t);
    };
  }, []);

  const remember = useCallback(
    (tool: string, decision: 'allow' | 'deny') => {
      void rememberToolDecision(tool, decision).catch((e) => {
        errorToast(
          e instanceof Error ? e.message : 'Failed to remember this decision for the project',
        );
      });
    },
    [rememberToolDecision],
  );

  /** Every manual ACP answer — Skip, Run, or a harness-specific extra option
   *  — funnels through here, so the scope contract is enforced in exactly one
   *  place. Two rules hold for every scope:
   *
   *   1. The CURRENT request is always answered. `project-reads` would not
   *      cover a `bash` request on its own, so picking it and pressing Run
   *      must still allow this one — a scope choice that silently left the
   *      agent blocked would be a trap.
   *   2. Persistent state is written only AFTER `onReply` resolves. A policy
   *      written for a request that never actually got answered would
   *      silently pre-answer future ones.
   *
   *  Skip is always once-only: the menu scopes the ALLOW. Making "Project ·
   *  everything" + Skip mean "block everything forever" would put the most
   *  destructive action in the same two clicks as the most permissive one. */
  const replyAcp = useCallback(
    async (
      permission: AcpPendingPermission,
      decision: 'allow' | 'deny',
      option: AcpPendingOption | null,
      labelOverride?: string,
      scope: ApprovalScope = 'once',
    ) => {
      const idKey = JSON.stringify(permission.id);
      const busyKey = `${idKey}:${decision}`;
      const effective: ApprovalScope = decision === 'deny' ? 'once' : scope;
      markBusy(busyKey);
      try {
        await onReply(permission.id, option ? optionValue(option) : undefined);
        // Canonical first-token key, never the raw string — see
        // `policyKeyFor`. Writing the raw string is what made a remembered
        // decision a no-op for every harness that titles its requests.
        if (effective === 'project-tool') remember(policyKeyFor(permission.permission), 'allow');
        if (effective === 'session-all') {
          onAutoApproveChange(true);
          // Flip the harness to its most-permissive mode too — the client-side
          // backstop above only answers requests that still ARRIVE, so on its
          // own the running turn keeps emitting new prompts. Best-effort: a
          // harness that advertises no such mode still has the backstop.
          try {
            await onAllowAllMode?.();
          } catch {
            // ignore — the client-side autoApprove backstop still unblocks.
          }
        }
        if (effective === 'project-reads' || effective === 'project-all') {
          void setAutoApprove(effective === 'project-reads' ? 'reads' : 'all').catch((e: unknown) =>
            errorToast(
              e instanceof Error ? e.message : 'Failed to update this project’s permission mode',
            ),
          );
        }
        const title = labelOverride ?? describePermission(permission).label;
        addRecord(
          idKey,
          `${decision === 'deny' ? 'Skipped' : 'Allowed'} — ${title}${SCOPE_RECORD_SUFFIX[effective]}`,
          decision === 'deny' ? 'negative' : 'positive',
        );
      } catch (e) {
        errorToast(e instanceof Error ? e.message : 'Failed to answer the permission request');
      } finally {
        clearBusy(busyKey);
      }
    },
    [
      onReply,
      addRecord,
      remember,
      markBusy,
      clearBusy,
      onAutoApproveChange,
      onAllowAllMode,
      setAutoApprove,
    ],
  );

  /** Routes an allow through the blanket-scope confirmation when it needs
   *  one, and straight through when it does not. */
  const runWithScope = useCallback((scope: ApprovalScope, apply: () => void) => {
    if (BLANKET_SCOPES.has(scope)) {
      setPendingBlanket({ scope, run: apply });
      return;
    }
    apply();
  }, []);

  // Persistent-policy auto-answer backstop — mirrors `useAcpSession`'s own
  // session-autoApprove effect (same dedupe-by-id-ref shape), but driven by
  // the PROJECT policy instead of the session toggle, and going through the
  // exact same `onReply` prop. A remembered `toolDecisions[tool]` wins over
  // `autoApprove`; `autoApprove: 'all'` waves through everything;
  // `autoApprove: 'reads'` only waves through read-only kinds.
  const autoAnsweredRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const permission of permissions) {
      const idKey = JSON.stringify(permission.id);
      if (autoAnsweredRef.current.has(idKey)) continue;
      // `permission.permission` is a fallback chain (`projectPermission` in
      // `@kortix/sdk`'s `acp/reduce.ts`) whose winning field may be a stable
      // tool kind (`bash`) OR a free-text title (`mkdir -p …`), depending on
      // the harness. `rememberedDecision` reads through both shapes plus the
      // legacy raw-string keys written before `policyKeyFor` existed, so a
      // decision saved on one request still fires on the next one.
      const decision = policyDecisionFor(policy, permission.permission);
      if (!decision) continue;
      autoAnsweredRef.current.add(idKey);
      const { allowOnce, deny } = resolvePermissionActionOptions(permission.options);
      const option = decision === 'deny' ? deny : allowOnce;
      // No `addRecord` on this path, deliberately. An auto-answer is the
      // user's earlier decision being honoured — narrating it flashes a
      // "Allowed — …" row for ~2s that they never asked for and cannot act
      // on. Combined with `willAutoAnswer` suppressing the pending row, a
      // request the policy already covers now produces NO UI at all, which is
      // the whole point of having configured the policy. The transcript still
      // shows the tool call itself, so nothing becomes invisible.
      //
      // On failure `autoAnsweredRef` is un-marked so a later render can retry,
      // and the row becomes visible again (`willAutoAnswer` is recomputed and
      // the request is still pending) — a request the agent never actually
      // got an answer to must never look resolved.
      void Promise.resolve(onReply(permission.id, option ? optionValue(option) : undefined)).catch(
        (e) => {
          autoAnsweredRef.current.delete(idKey);
          errorToast(
            e instanceof Error ? e.message : 'Failed to auto-answer the permission request',
          );
        },
      );
    }
  }, [permissions, policy, onReply]);

  /** Connector persistence — the project-policy write the old surface put in
   *  its own footer as `Always allow "slug.tool"`. Same call, same shape,
   *  now reached by the row's own scope menu so the user never has to
   *  connect two separate controls in their head. */
  const persistConnectorPolicy = useCallback(
    async (qualified: string, action: PolicyAction) => {
      const current = await listProjectPolicies(projectId);
      const withoutDup = (current.policies ?? []).filter((p) => p.match !== qualified);
      await setProjectPolicies(
        projectId,
        [{ match: qualified, action }, ...withoutDup],
        current.defaultMode ?? 'risk',
      );
    },
    [projectId],
  );

  /** The connector mutation speaks its own scope vocabulary — `once` /
   *  `session` (this exact action) / `session_all` (a `*` wildcard grant per
   *  connector) — which predates this menu and is why the menu's session tier
   *  has two entries rather than one. `project-tool` has no mutation scope at
   *  all: it is a `kortix.yaml` policy write layered on top of a normal
   *  once-approval. */
  const decideConnector = useCallback(
    async (a: SessionAuditAction, decision: 'approve' | 'deny', scope: ApprovalScope = 'once') => {
      const rowKey = a.execution_id;
      const busyKey = `${rowKey}:${decision === 'deny' ? 'deny' : 'allow'}`;
      const qualified = qualifiedConnectorAction(a);
      const effective: ApprovalScope = decision === 'deny' ? 'once' : scope;
      const mutationScope =
        effective === 'session-tool'
          ? 'session'
          : effective === 'session-all'
            ? 'session_all'
            : 'once';
      const persist = effective === 'project-tool' && canWritePolicies.allowed && !!qualified;
      markBusy(busyKey);
      try {
        await new Promise<void>((resolve, reject) => {
          resolveConnector.mutate(
            { executionId: rowKey, decision, scope: mutationScope },
            { onSuccess: () => resolve(), onError: reject },
          );
        });
        if (persist) {
          // Same ordering rule as the ACP side: persist only after the
          // in-flight request is actually answered.
          await persistConnectorPolicy(qualified, 'always_run').catch((e: unknown) =>
            errorToast(e instanceof Error ? e.message : 'Failed to update project policies'),
          );
        }
        const label = a.connector ?? a.action;
        addRecord(
          rowKey,
          `${decision === 'deny' ? 'Skipped' : 'Allowed'} — ${label}${SCOPE_RECORD_SUFFIX[effective]}`,
          decision === 'deny' ? 'negative' : 'positive',
        );
      } catch (e) {
        errorToast(e instanceof Error ? e.message : 'Failed to resolve approval');
      } finally {
        clearBusy(busyKey);
      }
    },
    [
      canWritePolicies.allowed,
      resolveConnector,
      persistConnectorPolicy,
      addRecord,
      markBusy,
      clearBusy,
    ],
  );

  // "Allow everything for this session" — a single consequential action
  // gated behind `ConfirmDialog`, and surfaced ONLY when more than one
  // request is stacked up (with a single row it is a footgun competing with
  // the answer the user came here to give). Covers both domains: flips the
  // ACP session-autoApprove backstop on and answers every currently-pending
  // ACP permission through the SAME `onReply`; resolves every pending
  // connector action (the first with the wildcard `session_all` scope,
  // matching the server's per-connector grant semantics, the rest `once`).
  // Each bulk-replied row gets its own `addRecord` after ITS OWN reply
  // resolves (consistency with every other answer path — manual clicks, the
  // policy auto-answer effect — none of which show a bare vanish).
  const confirmAllowEverything = useCallback(async () => {
    markBusy('all');
    try {
      onAutoApproveChange(true);
      // Flip the session to its most-permissive advertised mode FIRST, so the
      // running turn stops emitting new permission requests the instant it
      // asks for its next tool — resolving only the currently-pending ones (the
      // loop below) is not enough when the agent keeps generating more (the
      // real "Allow everything doesn't work" symptom). Best-effort: a harness
      // that advertises no such mode (or a transient failure) still falls
      // through to resolving the pending requests + the client-side backstop.
      try {
        await onAllowAllMode?.();
      } catch {
        // ignore — the client-side autoApprove backstop + per-request replies
        // below still unblock the currently-pending requests.
      }
      await Promise.all(
        permissions.map(async (permission) => {
          const { allowOnce } = resolvePermissionActionOptions(permission.options);
          await onReply(permission.id, allowOnce ? optionValue(allowOnce) : undefined);
          addRecord(
            JSON.stringify(permission.id),
            `Allowed — ${describePermission(permission).label}`,
            'positive',
          );
        }),
      );
      if (pendingConnectorActions.length) {
        const [first, ...rest] = pendingConnectorActions;
        await new Promise<void>((resolve, reject) => {
          resolveConnector.mutate(
            { executionId: first!.execution_id, decision: 'approve', scope: 'session_all' },
            {
              onSuccess: () => {
                addRecord(first!.execution_id, 'Allowed — this session', 'positive');
                resolve();
              },
              onError: reject,
            },
          );
        });
        await Promise.all(
          rest.map(
            (a) =>
              new Promise<void>((resolve, reject) => {
                resolveConnector.mutate(
                  { executionId: a.execution_id, decision: 'approve', scope: 'once' },
                  {
                    onSuccess: () => {
                      addRecord(a.execution_id, 'Allowed', 'positive');
                      resolve();
                    },
                    onError: reject,
                  },
                );
              }),
          ),
        );
      }
    } catch (e) {
      errorToast(e instanceof Error ? e.message : 'Failed to allow everything for this session');
    } finally {
      clearBusy('all');
      setConfirmAllOpen(false);
    }
  }, [
    permissions,
    pendingConnectorActions,
    onReply,
    onAutoApproveChange,
    onAllowAllMode,
    resolveConnector,
    addRecord,
    markBusy,
    clearBusy,
  ]);

  // A request that is ALREADY decided must never render as a question.
  //
  // Two layers answer without the user: the session-scoped `autoApprove`
  // backstop (owned by `useAcpSession`, which replies for every request while
  // it is on) and the project policy (answered by this file's own effect
  // above). Both are asynchronous, so the row used to mount, paint Skip/Run,
  // and unmount a moment later — the "it asks me for permission for a
  // millisecond and then goes" flash. Filtering here makes the suppression
  // synchronous: the row never reaches the DOM in the first place.
  const willAutoAnswer = (permission: AcpPendingPermission) =>
    autoApprove || policyDecisionFor(policy, permission.permission) !== null;

  // A row that already has an answered record (a manual click, which calls
  // `addRecord` synchronously) stops rendering as a pending prompt
  // immediately — it does not wait for the parent's `permissions`/audit props
  // to catch up and drop it. Without this, the SAME id can briefly appear as
  // both a pending row and a record row (a real possibility: the record is
  // added synchronously, the prop update that removes the id from
  // `permissions` lands on the next render), which is both a confusing
  // double-render and a duplicate React key.
  const visiblePermissions = permissions.filter(
    (permission) => !(JSON.stringify(permission.id) in records) && !willAutoAnswer(permission),
  );
  const visibleConnectorActions = pendingConnectorActions.filter(
    (a) => !(a.execution_id in records),
  );

  const hasRecords = Object.keys(records).length > 0;
  const pendingCount = visiblePermissions.length + visibleConnectorActions.length;
  const hasPending = pendingCount > 0;

  // Nothing to ask and nothing to report → render nothing. This used to keep
  // an empty bordered card on screen purely to host the "Allowing everything
  // for the rest of this session" strip, which read as a stray empty box
  // above it. That state now lives in the session header's More-actions menu,
  // where a session-wide mode belongs — it is not a pending request, and the
  // request surface should be absent when there are no requests.
  if (!hasPending && !hasRecords) return null;

  return (
    <div
      data-testid="acp-session-permission-prompt"
      className="bg-popover space-y-3 rounded-md border"
    >
      {hasPending ? (
        <div className="flex items-center gap-3 border-b px-4 py-3">
          <ShieldQuestion className="text-kortix-yellow size-4 shrink-0" />
          <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
            Kortix paused and needs your permission
          </span>
          {pendingCount > 1 ? (
            <>
              <Badge variant="secondary" size="xs" className="shrink-0 tabular-nums">
                {pendingCount}
              </Badge>
              <Button
                size="xs"
                variant="ghost"
                // `-mr-2.5` cancels the ghost button's own `px-2.5`: its
                // padding is invisible, so without this its LABEL stops ~10px
                // short of the Allow button's right edge below it and the
                // card's right margin reads ragged. Optical, not geometric.
                className="text-muted-foreground hover:text-foreground -mr-2.5 shrink-0 active:scale-[0.96]"
                disabled={isBusy('all')}
                onClick={() => setConfirmAllOpen(true)}
              >
                Allow all
              </Button>
            </>
          ) : null}
        </div>
      ) : null}

      <AnimatePresence initial={false}>
        <div className="px-4 pb-3">
          {visiblePermissions.map((permission) => {
            const idKey = JSON.stringify(permission.id);
            const { allowOnce, allowSession, deny, extra } = resolvePermissionActionOptions(
              permission.options,
            );
            const { label, mono, scope: noun, isCommand } = describePermission(permission);
            const rowScope = scopeFor(idKey);
            // Any scope that outlives this one request prefers the harness's own
            // `allow_always` option when it has one: a project policy stops
            // FUTURE sessions asking, and `allow_always` stops THIS session's
            // harness asking. Different layers, both wanted.
            const allowOption =
              rowScope === 'session-tool' || rowScope === 'project-tool'
                ? (allowSession ?? allowOnce)
                : allowOnce;
            return (
              <DecisionRow
                key={idKey}
                motionProps={rowMotion}
                title={label}
                mono={mono}
                isCommand={isCommand}
                detail={permissionDetail(permission)}
                busyKind={busyKindFor(idKey)}
                disabled={rowDisabled(idKey)}
                onAllow={() =>
                  runWithScope(
                    rowScope,
                    () => void replyAcp(permission, 'allow', allowOption, undefined, rowScope),
                  )
                }
                onDeny={() => void replyAcp(permission, 'deny', deny)}
                extraOptions={extra.map((option) => ({
                  key: optionValue(option),
                  label: option.label,
                  onSelect: () => void replyAcp(permission, 'allow', option, option.label),
                }))}
                scopeControl={
                  <ScopeMenu
                    value={rowScope}
                    noun={noun}
                    options={acpScopeOptions(noun)}
                    disabled={rowDisabled(idKey)}
                    onChange={(next) => setScope(idKey, next)}
                  />
                }
              />
            );
          })}

          {visibleConnectorActions.map((a) => {
            const rowKey = a.execution_id;
            const qualified = qualifiedConnectorAction(a);
            const connectorScope = scopeFor(rowKey);
            return (
              <DecisionRow
                key={rowKey}
                motionProps={rowMotion}
                title={a.connector ? `Use ${a.connector}` : 'Use a connected tool'}
                titleSuffix={
                  a.risk ? (
                    <Badge variant={riskTone(a.risk)} size="xs" className="shrink-0 capitalize">
                      {a.risk}
                    </Badge>
                  ) : undefined
                }
                detail={a.action}
                busyKind={busyKindFor(rowKey)}
                disabled={rowDisabled(rowKey)}
                onAllow={() =>
                  runWithScope(
                    connectorScope,
                    () => void decideConnector(a, 'approve', connectorScope),
                  )
                }
                onDeny={() => void decideConnector(a, 'deny')}
                scopeControl={
                  <ScopeMenu
                    value={connectorScope}
                    // The connector policy matches the qualified `slug.tool`
                    // path exactly, so that path IS what "All ___" means here.
                    noun={qualified ?? a.action}
                    options={connectorScopeOptions(
                      qualified ?? a.action,
                      // The project tier is offered only to members who can
                      // actually write the policy — an option the user has no
                      // permission to honour is worse than no option.
                      canWritePolicies.allowed && !!qualified,
                    )}
                    disabled={rowDisabled(rowKey)}
                    onChange={(next) => setScope(rowKey, next)}
                  />
                }
              />
            );
          })}

          {Object.entries(records).map(([key, record]) => (
            <RecordRow key={key} label={record.label} tone={record.tone} motionProps={rowMotion} />
          ))}
        </div>
      </AnimatePresence>

      {/* Two entry points, one dialog: the header's bulk "Allow all", and any
          blanket scope chosen from a row's menu. Both hand over authority
          beyond the request on screen, so both stop here first. */}
      <ConfirmDialog
        open={confirmAllOpen || !!pendingBlanket}
        onOpenChange={(open) => {
          if (open) return;
          setConfirmAllOpen(false);
          setPendingBlanket(null);
        }}
        title={
          pendingBlanket
            ? BLANKET_CONFIRM[pendingBlanket.scope]!.title
            : 'Allow everything for the rest of this session?'
        }
        description={
          pendingBlanket
            ? BLANKET_CONFIRM[pendingBlanket.scope]!.description
            : "Kortix won't ask again until this session ends — it can run commands, change files, and use connected tools on its own. You can turn this off at any time."
        }
        confirmLabel={
          pendingBlanket ? BLANKET_CONFIRM[pendingBlanket.scope]!.confirmLabel : 'Allow everything'
        }
        onConfirm={() => {
          if (pendingBlanket) {
            const { run } = pendingBlanket;
            setPendingBlanket(null);
            run();
            return;
          }
          void confirmAllowEverything();
        }}
        isPending={isBusy('all')}
      />
    </div>
  );
}
