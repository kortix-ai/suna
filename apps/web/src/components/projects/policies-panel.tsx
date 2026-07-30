'use client';

/**
 * Project-wide approval rules for tool calls. Source of truth = `kortix.yaml`;
 * this panel CRUDs the same file via the admin endpoint, then the gateway
 * enforces on every Executor call.
 *
 * Lives inside the Connectors page as a sibling tab — policies are *about*
 * what the executor (i.e. connectors) is allowed to do, so they belong here.
 *
 * Plain-language framing:
 *   • "Ask first" = require_approval
 *   • "Allow"     = always_run
 *   • "Block"     = block (also hidden from agent tool search)
 *   • Default behavior: "Ask before risky actions" (risk) vs "Run everything"
 *     (allow_all, legacy).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { InfoBanner } from '@/components/ui/info-banner';
import { Input } from '@/components/ui/input';
import { List, ListRow } from '@/components/ui/list';
import { SectionCard } from '@/components/ui/section-card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/features/layout/section/empty-state';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import {
  type PolicyAction,
  type PolicyArgCondition,
  type PolicyDefaultMode,
  type ProjectPolicy,
  listProjectPolicies,
  setProjectPolicies,
} from '@kortix/sdk';

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

const ACTION_META: Record<PolicyAction, { label: string; description: string; tint: string }> = {
  always_run: { label: 'Allow', description: 'Run without asking', tint: 'text-foreground' },
  require_approval: {
    label: 'Ask first',
    description: 'Pause for human approval',
    tint: 'text-amber-600 dark:text-amber-400',
  },
  block: { label: 'Block', description: 'Deny + hide from agents', tint: 'text-destructive' },
};

const DEFAULT_OPTIONS: Array<{ value: PolicyDefaultMode; label: string; description: string }> = [
  {
    value: 'risk',
    label: 'Ask before risky actions',
    description: 'Reads run automatically. Writes and deletes ask for approval.',
  },
  {
    value: 'allow_all',
    label: 'Run everything',
    description: 'Agents call any tool without asking — only the rules below can deny.',
  },
];

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
  const queryKey = useMemo(() => ['project-policies', projectId] as const, [projectId]);
  const query = useQuery({
    queryKey,
    queryFn: () => listProjectPolicies(projectId),
    staleTime: 20_000,
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
      const payload: ProjectPolicy[] = draft
        .map((d) => toPayloadRule(d))
        .filter((p) => p.match.length > 0);
      return setProjectPolicies(projectId, payload, defaultMode);
    },
    onSuccess: () => {
      toast.success('Policies saved');
      queryClient.invalidateQueries({ queryKey });
    },
    onError: (e: any) => toast.error(e?.message || 'Failed to save policies'),
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
    <div className="space-y-4">
      {/* ── Default behavior — single card, two compact segmented options ── */}
      <SectionCard
        title={tI18nHardcoded.raw(
          'autoComponentsProjectsPoliciesPanelJsxAttrTitleDefaultBehavior16e16541',
        )}
        description={tI18nHardcoded.raw(
          'autoComponentsProjectsPoliciesPanelJsxAttrDescriptionWhatHappensWhen4b8b2205',
        )}
      >
        {query.isLoading ? (
          <Skeleton className="h-14 rounded-2xl" />
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
                    'flex flex-col items-start gap-1 rounded-2xl border px-3 py-2.5 text-left transition-colors',
                    selected
                      ? 'border-primary/50 bg-primary/[0.06]'
                      : 'border-border/60 bg-card hover:bg-muted/40',
                  )}
                >
                  <div className="flex w-full items-center justify-between gap-2">
                    <span className="text-sm font-medium">{opt.label}</span>
                    {selected && (
                      <Badge variant="secondary" size="sm">
                        Current
                      </Badge>
                    )}
                  </div>
                  <p className="text-muted-foreground text-xs">{opt.description}</p>
                </button>
              );
            })}
          </div>
        )}
      </SectionCard>

      {/* ── Rules list ────────────────────────────────────────────────────── */}
      <SectionCard
        title="Rules"
        description={tI18nHardcoded.raw(
          'autoComponentsProjectsPoliciesPanelJsxAttrDescriptionTopToBottom4926dcea',
        )}
        count={draft.length > 0 ? draft.length : undefined}
        action={
          <Button
            size="sm"
            variant="outline"
            className="h-8 gap-1.5 text-xs"
            onClick={addRule}
            disabled={query.isLoading}
          >
            <Plus className="h-3.5 w-3.5" />
            {tI18nHardcoded.raw('autoComponentsProjectsPoliciesPanelJsxTextAddRulea294c4bd')}
          </Button>
        }
        flush
      >
        {parseErrors.length > 0 && (
          <div className="px-4 pt-3">
            <InfoBanner
              tone="warning"
              title={tI18nHardcoded.raw(
                'autoComponentsProjectsPoliciesPanelJsxAttrTitleKortixTomlHad8db85c74',
              )}
            >
              <ul className="ml-1 list-disc space-y-0.5">
                {parseErrors.map((e, i) => (
                  <li key={i} className="text-xs">
                    <span className="font-mono">{e.path}</span>: {e.error}
                  </li>
                ))}
              </ul>
            </InfoBanner>
          </div>
        )}

        {query.isLoading ? (
          <div className="space-y-2 p-4">
            {[0, 1].map((i) => (
              <Skeleton key={i} className="h-12 rounded-2xl" />
            ))}
          </div>
        ) : draft.length === 0 ? (
          <EmptyState
            icon={ShieldCheck}
            size="sm"
            title={tI18nHardcoded.raw(
              'autoComponentsProjectsPoliciesPanelJsxAttrTitleNoRulesYet795c2fb5',
            )}
            description={tI18nHardcoded.raw(
              'autoComponentsProjectsPoliciesPanelJsxAttrDescriptionRequireApprovalFor7e7b9477',
            )}
            action={
              <Button size="sm" variant="outline" className="gap-1.5" onClick={addRule}>
                <Plus className="h-3.5 w-3.5" />
                {tI18nHardcoded.raw('autoComponentsProjectsPoliciesPanelJsxTextAddRulea294c4bd')}
              </Button>
            }
          />
        ) : (
          <List>
            {draft.map((rule, idx) => (
              <ListRow
                key={rule.id}
                leading={
                  <span className="bg-muted/60 text-muted-foreground flex h-6 w-6 items-center justify-center rounded-full font-mono text-xs">
                    {idx + 1}
                  </span>
                }
                title={
                  <div className="flex flex-wrap items-center gap-2">
                    <Input
                      value={rule.match}
                      onChange={(e) => updateRule(rule.id, { match: e.target.value })}
                      placeholder={tI18nHardcoded.raw(
                        'autoComponentsProjectsPoliciesPanelJsxAttrPlaceholderStripeChargesCreate0ff0fa54',
                      )}
                      className="h-8 min-w-[16rem] flex-1 font-mono text-sm"
                      spellCheck={false}
                      aria-label={`Rule ${idx + 1} match pattern`}
                    />
                    <Select
                      value={rule.action}
                      onValueChange={(v) => updateRule(rule.id, { action: v as PolicyAction })}
                    >
                      <SelectTrigger
                        // The value shows label + description (e.g. "Ask first ·
                        // Pause for human approval"). Size to content with a
                        // floor so it never clips, and shrink-0 so the flex row
                        // can't squeeze it back into a truncation.
                        className={cn(
                          'h-8 w-auto min-w-[16rem] shrink-0',
                          ACTION_META[rule.action].tint,
                        )}
                        aria-label={`Rule ${idx + 1} action`}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {(['always_run', 'require_approval', 'block'] as PolicyAction[]).map(
                          (a) => (
                            <SelectItem key={a} value={a}>
                              <span className={cn('font-medium', ACTION_META[a].tint)}>
                                {ACTION_META[a].label}
                              </span>
                              <span className="text-muted-foreground ml-2 text-xs">
                                {ACTION_META[a].description}
                              </span>
                            </SelectItem>
                          ),
                        )}
                      </SelectContent>
                    </Select>
                  </div>
                }
                subtitle={
                  <div className="space-y-1.5">
                    <span className="text-muted-foreground text-xs">{matchHint(rule.match)}</span>
                    {/* Argument conditions. A tool-name pattern can only gate
                        WHICH tool runs; these gate WHAT it may be called with —
                        e.g. send_email restricted to an address allow-list. */}
                    {rule.conditions.length > 0 && (
                      <div className="border-border/60 space-y-1.5 border-l-2 pl-2.5">
                        {rule.conditions.map((cond, cIdx) => (
                          <div
                            key={cond.id}
                            className="flex flex-wrap items-center gap-1.5"
                          >
                            <span className="text-muted-foreground text-[11px]">only when</span>
                            <Input
                              value={cond.arg}
                              onChange={(e) =>
                                updateCondition(rule.id, cIdx, { arg: e.target.value })
                              }
                              placeholder="to"
                              spellCheck={false}
                              className="h-7 w-28 font-mono text-xs"
                              aria-label={`Rule ${idx + 1} condition ${cIdx + 1} argument`}
                            />
                            <button
                              type="button"
                              onClick={() =>
                                updateCondition(rule.id, cIdx, { negate: !cond.negate })
                              }
                              className={cn(
                                'rounded border px-1.5 py-0.5 text-[11px]',
                                cond.negate
                                  ? 'border-amber-500/40 text-amber-600 dark:text-amber-400'
                                  : 'border-border text-muted-foreground',
                              )}
                              aria-label={`Rule ${idx + 1} condition ${cIdx + 1} ${
                                cond.negate ? 'does not match' : 'matches'
                              }`}
                            >
                              {cond.negate ? 'does NOT match' : 'matches'}
                            </button>
                            <Input
                              value={cond.match}
                              onChange={(e) =>
                                updateCondition(rule.id, cIdx, { match: e.target.value })
                              }
                              placeholder="/^(owner|admin)@example\\.com$/"
                              spellCheck={false}
                              className="h-7 min-w-[12rem] flex-1 font-mono text-xs"
                              aria-label={`Rule ${idx + 1} condition ${cIdx + 1} pattern`}
                            />
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-7 w-7"
                              aria-label={`Remove rule ${idx + 1} condition ${cIdx + 1}`}
                              onClick={() => removeCondition(rule.id, cIdx)}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        ))}
                        <p className="text-muted-foreground text-[11px]">
                          A list argument must have EVERY value match. A missing argument never
                          matches, so an allow-list fails closed.
                        </p>
                      </div>
                    )}
                    <button
                      type="button"
                      onClick={() => addCondition(rule.id)}
                      className="text-muted-foreground hover:text-foreground text-[11px] underline-offset-2 hover:underline"
                    >
                      + Restrict by argument
                    </button>
                  </div>
                }
                trailing={
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={`Remove rule ${idx + 1}`}
                    onClick={() => removeRule(rule.id)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                }
              />
            ))}
          </List>
        )}
      </SectionCard>

      {/* ── Save bar (only when dirty) ────────────────────────────────────── */}
      {dirty && (
        <div
          className={cn(
            'bg-card sticky bottom-4 z-10 flex items-center justify-between gap-3 rounded-2xl border px-4 py-3 shadow-sm',
            'border-primary/40',
          )}
        >
          <div className="text-muted-foreground text-xs">
            {tI18nHardcoded.raw(
              'autoComponentsProjectsPoliciesPanelJsxTextUnsavedChangesSavingCommitse36b25bc',
            )}{' '}
            <code className="bg-muted rounded px-1 py-0.5 font-mono text-xs">kortix.yaml</code>.
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={revert} disabled={save.isPending}>
              Revert
            </Button>
            <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending}>
              {save.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {tI18nHardcoded.raw('autoComponentsProjectsPoliciesPanelJsxTextSaveChanges3a1ef407')}
            </Button>
          </div>
        </div>
      )}
    </div>
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
  const conditions = d.conditions
    .map((c) => ({
      arg: c.arg.trim(),
      match: c.match.trim(),
      ...(c.negate ? { negate: true } : {}),
    }))
    .filter((c) => c.arg.length > 0 && c.match.length > 0);
  return {
    match: d.match.trim(),
    action: d.action,
    ...(conditions.length > 0 ? { conditions } : {}),
  };
}
