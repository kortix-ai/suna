'use client';

/**
 * Project-wide approval rules for tool calls. Source of truth = `kortix.yaml`;
 * this panel CRUDs the same file via the admin endpoint, then the gateway
 * enforces on every Connector call.
 *
 * Rendered in two places: the Global rules sheet on the capabilities pages, and
 * the Connectors section of the customize panel. Both are narrow columns, so
 * the layout is a single stack of `Label` + `bg-popover rounded-md border`
 * panels — the `settings-view.tsx` dialect. No `SectionCard`, no `List`.
 *
 * Plain-language framing (the UI never says the wire value):
 *   • "Ask first" = require_approval
 *   • "Allow"     = always_run
 *   • "Block"     = block (also hidden from agent tool search)
 *   • Default behavior: "Ask before risky actions" (risk) vs "Run everything"
 *     (allow_all, legacy).
 */
import { CheckIcon, PlusIcon, ShieldCheckIcon, TrashIcon } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { InfoBanner } from '@/components/ui/info-banner';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import Loading from '@/components/ui/loading';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { errorToast, successToast } from '@/components/ui/toast';
import { EmptyState } from '@/features/layout/section/empty-state';
import { cn } from '@/lib/utils';
import {
  type PolicyAction,
  type PolicyArgCondition,
  type PolicyDefaultMode,
  type ProjectPolicy,
  listProjectPolicies,
  setProjectPolicies,
} from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';

interface DraftRule {
  id: string;
  match: string;
  action: PolicyAction;
  /**
   * Argument conditions. Carried through the draft even when the rule isn't
   * being edited: this panel replaces the WHOLE policy list on save, so a field
   * the draft forgets is a field the save DELETES.
   */
  conditions: DraftCondition[];
}

/**
 * A condition plus a stable client id. The id is draft-only (stripped by
 * `toPayloadRule`) and exists so React keys survive reordering — keying on the
 * array index makes deleting a middle row re-use the removed row's DOM node,
 * which strands whatever the user had typed in the row below it.
 */
interface DraftCondition extends PolicyArgCondition {
  id: string;
}

/**
 * Label + description are separate so the trigger can show the label alone.
 * Putting the description in the trigger is what previously forced a
 * `min-w-[16rem]` select and squeezed the pattern input beside it.
 */
const ACTION_META: Record<PolicyAction, { label: string; description: string; tint: string }> = {
  always_run: { label: 'Allow', description: 'Runs without asking', tint: 'text-foreground' },
  require_approval: {
    label: 'Ask first',
    description: 'Waits for your approval',
    tint: 'text-kortix-orange',
  },
  block: {
    label: 'Block',
    description: 'Never runs, and agents cannot see it',
    tint: 'text-kortix-red',
  },
};

const ACTION_ORDER: PolicyAction[] = ['always_run', 'require_approval', 'block'];

const DEFAULT_OPTIONS: Array<{ value: PolicyDefaultMode; label: string; description: string }> = [
  {
    value: 'risk',
    label: 'Ask before risky actions',
    description: 'Reads run on their own. Writes and deletes wait for your approval.',
  },
  {
    value: 'allow_all',
    label: 'Run everything',
    description: 'Every tool runs without asking. Only the rules below can stop one.',
  },
];

/** Wire value ↔ the two plain-language options in the condition select. */
const CONDITION_MATCHES = 'matches';
const CONDITION_EXCLUDES = 'excludes';

function newRuleId() {
  return Math.random().toString(36).slice(2, 10);
}

/**
 * Seeded draft rules + default mode + canonical server signature derived from a
 * `listProjectPolicies` response.
 *
 * Extracted as a pure helper so the exact prod failure shape
 * (Better Stack pattern `236e88fb…` — `Cannot read properties of undefined
 * (reading 'map')` in the project layout's `?c=global` → `GlobalRulesPanel` →
 * `PoliciesPanel` path) can be unit-tested directly without a react-query
 * harness. `listProjectPolicies` is typed to always return `policies` /
 * `defaultMode`, but a 200 with a missing/`null` `policies` field (empty/new
 * project, a backend shape gap, a partial response) is a valid HTTP outcome; the
 * prior `if (!query.data) return` guard only covered `query.data` itself, so
 * `query.data`'s `policies` field accessed via `.map` threw. The `?? []` / `?? 'allow_all'`
 * absorb that without changing the happy path. Mirrors the chunk-22256
 * `toArray()` guard (#4542).
 */
export function seedDraft(data: {
  policies?: ProjectPolicy[] | null;
  defaultMode?: PolicyDefaultMode | null;
}): {
  draft: DraftRule[];
  defaultMode: PolicyDefaultMode;
  serverSig: string;
} {
  const policies = data.policies ?? [];
  const defaultMode = data.defaultMode ?? 'allow_all';
  return {
    draft: policies.map((p) => ({
      id: newRuleId(),
      match: p.match,
      action: p.action,
      conditions: (p.conditions ?? []).map((c) => ({ ...c, id: newRuleId() })),
    })),
    defaultMode,
    // `JSON.stringify` drops `undefined` values to `null`, so coercing here
    // keeps the signature `[]`-stable (a subsequent save would otherwise write
    // `policies: null`).
    serverSig: JSON.stringify({ policies, defaultMode }),
  };
}

export function PoliciesPanel({ projectId }: { projectId: string }) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const queryClient = useQueryClient();
  // qk.project.executorPolicies — sandbox tool-execution allow/deny rules
  // (`listProjectPolicies`, `/executor/projects/:id/policies`). NOT
  // qk.project.policies, the unrelated account-IAM role-policy family
  // members-view.tsx reads: both used to share the literal
  // ['project-policies', id] pre-migration, so whichever fetch resolved
  // last clobbered the other's cache entry with an incompatible shape.
  const queryKey = useMemo(() => qk.project.executorPolicies(projectId), [projectId]);
  const query = useQuery({
    queryKey,
    queryFn: () => listProjectPolicies(projectId),
    ...contract('config'),
  });

  const [draft, setDraft] = useState<DraftRule[]>([]);
  const [defaultMode, setDefaultMode] = useState<PolicyDefaultMode>('allow_all');
  const [serverSig, setServerSig] = useState<string>('');

  useEffect(() => {
    if (!query.data) return;
    const seeded = seedDraft(query.data);
    setDraft(seeded.draft);
    setDefaultMode(seeded.defaultMode);
    setServerSig(seeded.serverSig);
  }, [query.data]);

  const currentSig = JSON.stringify({
    policies: draft.map((d) => toPayloadRule(d)),
    defaultMode,
  });
  const dirty = currentSig !== serverSig;

  const save = useMutation({
    mutationFn: async () => {
      const payload: ProjectPolicy[] = [];
      for (const d of draft) {
        const p = toPayloadRule(d);
        if (p.match.length > 0) payload.push(p);
      }
      return setProjectPolicies(projectId, payload, defaultMode);
    },
    onSuccess: () => {
      successToast('Global rules saved');
      queryClient.invalidateQueries({ queryKey });
    },
    onError: (error: Error) => errorToast(error.message || 'Failed to save global rules'),
  });

  const isForbidden = query.isError && /403|forbidden/i.test((query.error as Error)?.message ?? '');

  function updateRule(
    id: string,
    patch: Partial<Pick<DraftRule, 'match' | 'action' | 'conditions'>>,
  ) {
    setDraft((rows) => rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }
  function updateCondition(ruleId: string, index: number, patch: Partial<PolicyArgCondition>) {
    setDraft((rows) =>
      rows.map((r) =>
        r.id === ruleId
          ? { ...r, conditions: r.conditions.map((c, i) => (i === index ? { ...c, ...patch } : c)) }
          : r,
      ),
    );
  }
  function addCondition(ruleId: string) {
    setDraft((rows) =>
      rows.map((r) =>
        r.id === ruleId
          ? { ...r, conditions: [...r.conditions, { id: newRuleId(), arg: '', match: '' }] }
          : r,
      ),
    );
  }
  function removeCondition(ruleId: string, index: number) {
    setDraft((rows) =>
      rows.map((r) =>
        r.id === ruleId ? { ...r, conditions: r.conditions.filter((_, i) => i !== index) } : r,
      ),
    );
  }
  // Draft-only edits — nothing leaves the browser until Save changes. That is
  // why removing a rule needs no ConfirmDialog: Revert is one click away.
  function removeRule(id: string) {
    setDraft((rows) => rows.filter((r) => r.id !== id));
  }
  function addRule() {
    setDraft((rows) => [
      ...rows,
      { id: newRuleId(), match: '', action: 'require_approval', conditions: [] },
    ]);
  }
  function revert() {
    if (!query.data) return;
    const seeded = seedDraft(query.data);
    setDraft(seeded.draft);
    setDefaultMode(seeded.defaultMode);
  }

  if (isForbidden) {
    return (
      <InfoBanner
        tone="warning"
        title={tI18nHardcoded.raw(
          'autoComponentsProjectsPoliciesPanelJsxAttrTitleAdminAccessRequired34f66101',
        )}
      >
        {tI18nHardcoded.raw(
          'autoComponentsProjectsPoliciesPanelJsxTextOnlyProjectManagersCan603f67fc',
        )}
      </InfoBanner>
    );
  }

  const parseErrors = query.data?.errors ?? [];

  return (
    <div className="flex h-full w-full flex-1 grow flex-col space-y-8">
      {/* ── Default behavior ───────────────────────────────────────────────── */}
      <section className="space-y-4">
        <div className="space-y-1">
          <Label>Default behavior</Label>
          <p className="text-muted-foreground text-xs text-pretty">
            What happens when no rule below matches. Override a single tool with a rule.
          </p>
        </div>

        {query.isLoading ? (
          <div className="grid gap-2 sm:grid-cols-2">
            <Skeleton className="h-18 rounded-md" />
            <Skeleton className="h-18 rounded-md" />
          </div>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            {DEFAULT_OPTIONS.map((opt) => {
              const selected = defaultMode === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setDefaultMode(opt.value)}
                  aria-pressed={selected}
                  className={cn(
                    'flex cursor-pointer flex-col items-start gap-1 rounded-md border px-4 py-3 text-left',
                    // Never `transition-all` — `scale` is listed so the press
                    // feedback below actually eases instead of snapping.
                    'transition-[background-color,border-color,scale] duration-150 ease-out',
                    'motion-safe:active:scale-[0.99]',
                    selected
                      ? 'border-primary/40 bg-primary/[0.06]'
                      : 'bg-popover hover:bg-foreground/[0.03]',
                  )}
                >
                  <span className="flex w-full items-center justify-between gap-2">
                    <span className="text-foreground text-sm font-medium">{opt.label}</span>
                    {selected ? <CheckIcon className="text-foreground size-4 shrink-0" /> : null}
                  </span>
                  <span className="text-muted-foreground text-xs text-pretty">
                    {opt.description}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </section>

      {/* ── Rules ──────────────────────────────────────────────────────────── */}
      <section className="space-y-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            <Label>Rules</Label>
            <p className="text-muted-foreground text-xs text-pretty">
              Checked top to bottom — the first match wins. Rules here override what a connector
              asks for.
            </p>
          </div>
          {/* The empty state owns the CTA when there is nothing to list, so the
              two "Add rule" buttons are never on screen together. */}
          {draft.length > 0 && (
            <Button
              size="sm"
              variant="secondary"
              className="shrink-0 gap-1.5 self-start sm:self-auto"
              onClick={addRule}
              disabled={query.isLoading}
            >
              <PlusIcon className="size-4 shrink-0" />
              Add rule
            </Button>
          )}
        </div>

        {parseErrors.length > 0 && (
          <InfoBanner
            tone="warning"
            title={tI18nHardcoded.raw(
              'autoComponentsProjectsPoliciesPanelJsxAttrTitleKortixTomlHad8db85c74',
            )}
          >
            <ul className="space-y-1">
              {parseErrors.map((e) => (
                <li key={`${e.path}:${e.error}`} className="text-xs">
                  <span className="font-mono">{e.path}</span>: {e.error}
                </li>
              ))}
            </ul>
          </InfoBanner>
        )}

        {query.isLoading ? (
          <div className="space-y-2">
            {[0, 1].map((i) => (
              <Skeleton key={i} className="h-28 rounded-md" />
            ))}
          </div>
        ) : draft.length === 0 ? (
          <div className="bg-popover rounded-md border">
            <EmptyState
              icon={ShieldCheckIcon}
              size="sm"
              className="p-8 md:p-10"
              title={tI18nHardcoded.raw(
                'autoComponentsProjectsPoliciesPanelJsxAttrTitleNoRulesYet795c2fb5',
              )}
              description={tI18nHardcoded.raw(
                'autoComponentsProjectsPoliciesPanelJsxAttrDescriptionRequireApprovalFor7e7b9477',
              )}
              action={
                <Button size="sm" variant="outline" className="gap-1.5" onClick={addRule}>
                  <PlusIcon className="size-4 shrink-0" />
                  Add rule
                </Button>
              }
            />
          </div>
        ) : (
          <ul className="space-y-2">
            {draft.map((rule, idx) => (
              <RuleRow
                key={rule.id}
                rule={rule}
                index={idx}
                onChange={(patch) => updateRule(rule.id, patch)}
                onRemove={() => removeRule(rule.id)}
                onAddCondition={() => addCondition(rule.id)}
                onChangeCondition={(cIdx, patch) => updateCondition(rule.id, cIdx, patch)}
                onRemoveCondition={(cIdx) => removeCondition(rule.id, cIdx)}
              />
            ))}
          </ul>
        )}
      </section>

      {/* ── Save bar (only while there is something to save) ────────────────── */}
      {dirty && (
        <div className="bg-popover z-10 mt-auto flex flex-wrap items-center justify-between gap-3 rounded-md border px-4 py-3">
          <p className="text-muted-foreground min-w-0 text-xs text-pretty">
            Unsaved changes. Saving writes to{' '}
            <code className="bg-muted text-foreground rounded-sm px-1 py-0.5 font-mono text-xs">
              kortix.yaml
            </code>
            .
          </p>
          <div className="flex shrink-0 items-center gap-2">
            <Button variant="ghost" size="sm" onClick={revert} disabled={save.isPending}>
              Revert
            </Button>
            <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending}>
              {save.isPending ? <Loading className="size-4 shrink-0" /> : null}
              Save changes
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * One rule: which tool it covers, what to do, and any argument conditions.
 *
 * Padding sits on the row itself because the row hosts no flush children — the
 * conditions group is inset with a left hairline rather than a full-width seam,
 * which keeps a rule reading as one object instead of a stack of cards.
 */
function RuleRow({
  rule,
  index,
  onChange,
  onRemove,
  onAddCondition,
  onChangeCondition,
  onRemoveCondition,
}: {
  rule: DraftRule;
  index: number;
  onChange: (patch: Partial<Pick<DraftRule, 'match' | 'action' | 'conditions'>>) => void;
  onRemove: () => void;
  onAddCondition: () => void;
  onChangeCondition: (index: number, patch: Partial<PolicyArgCondition>) => void;
  onRemoveCondition: (index: number) => void;
}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const position = index + 1;

  return (
    <li className="bg-popover space-y-3 rounded-md border px-4 py-3">
      <div className="flex items-start gap-3">
        <span className="text-muted-foreground flex h-9 w-4 shrink-0 items-center justify-end font-mono text-xs tabular-nums">
          {position}
        </span>

        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              value={rule.match}
              onChange={(e) => onChange({ match: e.target.value })}
              placeholder={tI18nHardcoded.raw(
                'autoComponentsProjectsPoliciesPanelJsxAttrPlaceholderStripeChargesCreate0ff0fa54',
              )}
              variant="popover"
              className="min-w-0 flex-1 font-mono text-xs"
              spellCheck={false}
              aria-label={`Rule ${position} tool`}
            />
            {/* `SelectItem description` renders in the menu only, never in the
                trigger — so the closed control is just "Ask first" and the row
                keeps its width for the tool pattern beside it. */}
            <Select
              value={rule.action}
              onValueChange={(v) => onChange({ action: v as PolicyAction })}
            >
              <SelectTrigger
                variant="outline"
                className="w-full shrink-0 sm:w-40"
                aria-label={`Rule ${position} action`}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ACTION_ORDER.map((a) => (
                  <SelectItem key={a} value={a} description={ACTION_META[a].description}>
                    <span className={cn('text-sm font-medium', ACTION_META[a].tint)}>
                      {ACTION_META[a].label}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <p className="text-muted-foreground text-xs text-pretty">{matchHint(rule.match)}</p>
        </div>

        <Button
          size="icon-md"
          variant="ghost"
          className="text-muted-foreground hover:text-foreground shrink-0"
          aria-label={`Remove rule ${position}`}
          onClick={onRemove}
        >
          <TrashIcon className="size-4 shrink-0" />
        </Button>
      </div>

      {/* Argument conditions. A tool pattern can only gate WHICH tool runs;
          these gate WHAT it may be called with — e.g. send_email restricted to
          an address allow-list. */}
      {rule.conditions.length > 0 && (
        <div className="border-border ml-7 space-y-2 border-l pl-4">
          <p className="text-muted-foreground text-xs">Only when</p>

          {rule.conditions.map((cond, cIdx) => (
            <div key={cond.id} className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <Input
                value={cond.arg}
                onChange={(e) => onChangeCondition(cIdx, { arg: e.target.value })}
                placeholder="to"
                variant="popover"
                className="font-mono text-xs sm:w-28"
                spellCheck={false}
                aria-label={`Rule ${position} condition ${cIdx + 1} field`}
              />
              <Select
                value={cond.negate ? CONDITION_EXCLUDES : CONDITION_MATCHES}
                onValueChange={(v) => onChangeCondition(cIdx, { negate: v === CONDITION_EXCLUDES })}
              >
                <SelectTrigger
                  variant="outline"
                  className="w-full shrink-0 text-xs sm:w-36"
                  aria-label={`Rule ${position} condition ${cIdx + 1} comparison`}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={CONDITION_MATCHES}>Matches</SelectItem>
                  <SelectItem value={CONDITION_EXCLUDES}>Does not match</SelectItem>
                </SelectContent>
              </Select>
              <Input
                value={cond.match}
                onChange={(e) => onChangeCondition(cIdx, { match: e.target.value })}
                placeholder="/^(owner|admin)@example\.com$/"
                variant="popover"
                className="min-w-0 flex-1 font-mono text-xs"
                spellCheck={false}
                aria-label={`Rule ${position} condition ${cIdx + 1} pattern`}
              />
              <Button
                size="icon-md"
                variant="ghost"
                className="text-muted-foreground hover:text-foreground shrink-0 self-end sm:self-auto"
                aria-label={`Remove rule ${position} condition ${cIdx + 1}`}
                onClick={() => onRemoveCondition(cIdx)}
              >
                <TrashIcon className="size-4 shrink-0" />
              </Button>
            </div>
          ))}

          <p className="text-muted-foreground text-xs text-pretty">
            A list must have every value match. A missing field never matches, so an allow-list
            fails closed.
          </p>
        </div>
      )}

      {/* `-ml-2.5` cancels the button's own `px-2.5`, so the label starts flush
          with the row's content edge instead of floating 10px inside it. */}
      <Button
        variant="ghost"
        size="sm"
        className="text-muted-foreground hover:text-foreground -ml-2.5 gap-1.5"
        onClick={onAddCondition}
      >
        <PlusIcon className="size-3.5 shrink-0" />
        Add condition
      </Button>
    </li>
  );
}

function matchHint(raw: string): string | null {
  const m = raw.trim();
  if (!m) return 'Enter a tool id — or use * to match every tool.';
  if (m === '*') return 'Matches every tool from every connector.';
  if (m.endsWith('.*')) {
    const prefix = m.slice(0, -2);
    if (!prefix.includes('.')) return `Matches every tool inside the "${prefix}" connector.`;
    return `Matches every tool whose id starts with "${prefix}.".`;
  }
  if (m.includes('*')) return 'Matches any tool id where * stands in for any text.';
  return `Matches exactly "${m}".`;
}

/**
 * Draft rule → the wire shape. Trims, and omits `conditions` entirely when the
 * rule has none so an unconditional rule serializes exactly as it always did
 * (no `conditions: []` churn in every project's kortix.yaml).
 *
 * Blank condition rows are dropped: a half-typed row must never reach the API,
 * where it would be rejected as invalid and block the whole save.
 */
export function toPayloadRule(d: DraftRule): ProjectPolicy {
  const conditions: NonNullable<ProjectPolicy['conditions']> = [];
  for (const c of d.conditions) {
    const arg = c.arg.trim();
    const match = c.match.trim();
    if (arg.length > 0 && match.length > 0) {
      conditions.push({ arg, match, ...(c.negate ? { negate: true } : {}) });
    }
  }
  return {
    match: d.match.trim(),
    action: d.action,
    ...(conditions.length > 0 ? { conditions } : {}),
  };
}
