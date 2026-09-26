'use client';

import { useLocalizedUiCatalog } from '@/i18n/use-localized-ui-catalog';
import { useTranslations } from '@/i18n/use-translations';
import {
  type AdminConnector,
  type ConnectorPolicyAction,
  type ConnectorPolicyRule,
  getConnectorPolicies,
  setConnectorPolicies,
  setConnectorSensitive,
} from '@kortix/sdk';
import {
  CaretDownIcon,
  LockIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  XIcon,
} from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { InfoBanner } from '@/components/ui/info-banner';
import { Input } from '@/components/ui/input';
import {
  InputGroupSearch,
  InputGroupSearchClear,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from '@/components/ui/input-group';
import Loading from '@/components/ui/loading';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { errorToast, successToast } from '@/components/ui/toast';
import { ErrorState } from '@/features/layout/section/error-state';

import {
  draftToRules,
  type PatternDraftRow,
  seedPatternDraft,
  signPatternRules,
} from '@/features/workspace/capabilities/connectors/tools/pattern-rule-draft';
import {
  filterActions,
  groupToolsByRisk,
  type ToolGroup,
  toolRowText,
} from '@/features/workspace/capabilities/connectors/tools/tool-groups';
import {
  applyBulkPolicy,
  isLockedByProject,
  isPatternRule,
  orderPolicyRules,
  type PolicyChoice,
  previewEffective,
  toolChoice,
} from '@/features/workspace/capabilities/connectors/tools/tool-policy';
import { ToolPolicyControl } from '@/features/workspace/capabilities/connectors/tools/tool-policy-control';
import {
  POLICY_CHOICE_LABEL,
  POLICY_SEGMENTS,
} from '@/features/workspace/capabilities/connectors/tools/tool-policy-labels';
import { CatalogNoMatch } from '@/features/workspace/capabilities/shared/catalog/catalog-empty-state';

/** Below this many tools the search field is clutter; above it the list is
 *  unusable without one. */
const SEARCH_THRESHOLD = 6;

const POLICY_QUERY_STALE_MS = 5_000;

const LOCKED_REASON =
  'A project rule already decides this tool. Change it under Global rules on the Connectors page.';

type PoliciesData = Awaited<ReturnType<typeof getConnectorPolicies>>;

/**
 * One write of the whole rule list, plus what it means for the tools on
 * screen. `paths` + `choice` exist so the optimistic update can move the
 * server-resolved `effective` entries too — the rows read those, not
 * `policies`, so patching only `policies` would let every control snap back to
 * its old value until the refetch landed.
 */
interface PolicyWrite {
  rules: ConnectorPolicyRule[];
  paths?: readonly string[];
  choice?: PolicyChoice;
}

let patternRowSeq = 0;
const nextPatternRowId = () => `pattern-${++patternRowSeq}`;

export interface ConnectorToolsProps {
  projectId: string;
  connector: AdminConnector;
  displayName: string;
  canWrite: boolean;
  /** The authorization owner is mid-update — freeze every write on this tab. */
  disabled: boolean;
  /** Refetch the connector record: `sensitive` lives on it. */
  onChanged: () => void;
}

/**
 * Tools — what this connector is allowed to do, as a per-tool decision instead
 * of a dropdown and a save button.
 *
 * Three things make this readable to someone who is not going to study a
 * policy engine:
 *
 * 1. **Two groups, not three.** `groupToolsByRisk` folds `destructive` into
 *    writes. The only question a reader is equipped to answer before granting
 *    access is "can this look at my data, or change it".
 * 2. **Default is a state, not a value.** A tool the platform allows by
 *    default renders with NO segment lit and a `Hint` naming the default.
 *    Lighting Allow would claim a choice nobody made.
 * 3. **A project rule is not editable here.** Project scope is evaluated first
 *    and wins (`resolveEffectiveAction`, connectors/policy.ts:342), so those rows
 *    are disabled and say where the rule actually lives.
 *
 * The `sensitive` toggle and the pattern-rule editor render PLAINLY below
 * the list — they lived behind an "Advanced" disclosure until 2026-09-14
 * (Jay: the fold hid the one control a failing connector's owner wants).
 */
export function ConnectorTools({
  projectId,
  connector,
  displayName,
  canWrite,
  disabled,
  onChanged,
}: ConnectorToolsProps) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const policySegments = useLocalizedUiCatalog(POLICY_SEGMENTS);
  const queryClient = useQueryClient();
  const slug = connector.slug;
  const queryKey = useMemo(() => ['connector-policies', projectId, slug], [projectId, slug]);

  // Reading policies is admin-gated on the server (`resolveAdmin`,
  // connectors/router.ts:1193), so a reader would get a 403 and a permanent
  // skeleton. `connectorTabs` already hides this tab from them; the guard
  // below keeps that true if it ever stops doing so.
  const policiesQuery = useQuery({
    queryKey,
    queryFn: () => getConnectorPolicies(projectId, slug),
    staleTime: POLICY_QUERY_STALE_MS,
    enabled: canWrite,
  });

  const policies = useMemo(() => policiesQuery.data?.policies ?? [], [policiesQuery.data]);
  const effective = useMemo(() => policiesQuery.data?.effective ?? [], [policiesQuery.data]);
  const toolPaths = useMemo(
    () => new Set(connector.actions.map((action) => action.path)),
    [connector.actions],
  );

  // A rule is a per-tool decision only if it names one live tool exactly.
  // Everything else — globs, regexes, and rules left behind by a tool the
  // connector no longer reports — belongs to the Advanced editor, where it
  // stays visible and editable instead of being silently dropped on the next
  // save.
  const toolRules = useMemo(
    () => policies.filter((rule) => !isPatternRule(rule.match) && toolPaths.has(rule.match)),
    [policies, toolPaths],
  );
  const advancedRules = useMemo(
    () => policies.filter((rule) => isPatternRule(rule.match) || !toolPaths.has(rule.match)),
    [policies, toolPaths],
  );

  const [query, setQuery] = useState('');
  const matches = useMemo(
    () => filterActions(connector.actions, query),
    [connector.actions, query],
  );
  const groups = useMemo(() => groupToolsByRisk(matches, tI18nComplete), [matches, tI18nComplete]);
  // Write and Read-only each sit in their own disclosure (Jay, 2026-09-26),
  // counted from the WHOLE tool list — a search narrows the rows inside, never
  // the groups themselves, so the headers do not jump while typing.
  const allGroups = useMemo(
    () => groupToolsByRisk(connector.actions, tI18nComplete),
    [connector.actions, tI18nComplete],
  );

  const projectLockedCount = useMemo(
    () => effective.filter((entry) => entry.source === 'project').length,
    [effective],
  );

  const writePolicies = useMutation<
    Awaited<ReturnType<typeof setConnectorPolicies>>,
    Error,
    PolicyWrite,
    { previous: PoliciesData | undefined }
  >({
    mutationFn: (write) => setConnectorPolicies(projectId, slug, orderPolicyRules(write.rules)),
    onMutate: async (write) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<PoliciesData>(queryKey);
      queryClient.setQueryData<PoliciesData>(queryKey, (old) =>
        old
          ? {
              ...old,
              policies: orderPolicyRules(write.rules),
              effective:
                write.paths && write.choice
                  ? previewEffective(old.effective ?? [], write.paths, write.choice)
                  : old.effective,
            }
          : old,
      );
      return { previous };
    },
    onError: (error, _write, context) => {
      if (context?.previous) queryClient.setQueryData(queryKey, context.previous);
      errorToast(error.message || tI18nComplete.raw('text2b52d8b009f9'));
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey });
    },
  });

  const sensitiveMutation = useMutation({
    mutationFn: (next: boolean) => setConnectorSensitive(projectId, slug, next),
    onSuccess: (_result, next) => {
      successToast(
        next ? tI18nComplete.raw('text8aa6061345d9') : tI18nComplete.raw('text02a865a79c8b'),
      );
      void queryClient.invalidateQueries({ queryKey });
      onChanged();
    },
    onError: (error: Error) => errorToast(error.message || tI18nComplete.raw('text8eb4917bbe54')),
  });

  const busy = writePolicies.isPending || sensitiveMutation.isPending;
  const frozen = disabled || !canWrite;

  const setToolPolicy = (path: string, choice: PolicyChoice) =>
    writePolicies.mutate({
      rules: applyBulkPolicy(policies, [path], choice),
      paths: [path],
      choice,
    });

  // ── Bulk apply ──────────────────────────────────────────────────────────
  // One click that rewrites every row in a group is the one whose blast radius
  // is not visible from the control, so it goes through ConfirmDialog with the
  // exact count. Project-locked paths are excluded: writing a connector rule
  // under a project rule changes nothing.
  const [bulk, setBulk] = useState<{ group: ToolGroup; choice: PolicyChoice } | null>(null);
  const bulkPathsFor = (group: ToolGroup) => {
    const paths: string[] = [];
    for (const action of group.actions) {
      if (!isLockedByProject(action.path, effective)) paths.push(action.path);
    }
    return paths;
  };
  const bulkPaths = bulk ? bulkPathsFor(bulk.group) : [];

  // ── Advanced: pattern rules ─────────────────────────────────────────────
  const advancedSignature = useMemo(() => signPatternRules(advancedRules), [advancedRules]);
  const [draft, setDraft] = useState<PatternDraftRow[]>([]);
  // Reseed only when the SERVER's pattern set actually changes. A per-tool
  // write invalidates the same query, and reseeding on every refetch would
  // wipe a half-typed rule out from under the user.
  //
  // `signPatternRules` normalizes through `orderPolicyRules` before comparing,
  // because the optimistic write at `onMutate` reorders the very array this
  // guard reads. Without that, one click on any per-tool segment moved the
  // rules, changed the signature, and reseeded — see `pattern-rule-draft.ts`.
  const seededSignature = useRef<string | null>(null);
  useEffect(() => {
    if (!policiesQuery.data) return;
    if (seededSignature.current === advancedSignature) return;
    seededSignature.current = advancedSignature;
    setDraft(seedPatternDraft(advancedRules, nextPatternRowId));
  }, [policiesQuery.data, advancedSignature, advancedRules]);

  const draftSignature = signPatternRules(draftToRules(draft));
  const advancedDirty = draftSignature !== advancedSignature;

  const savePatternRules = () =>
    writePolicies.mutate({ rules: [...toolRules, ...draftToRules(draft)] });

  if (!canWrite) {
    return (
      <p className="text-muted-foreground text-sm text-pretty">
        {tI18nComplete.raw('textdb7d057a2f68')} {displayName}{' '}
        {tI18nComplete.raw('text24984f203fd7')}
      </p>
    );
  }

  return (
    <div className="space-y-5">
      {/* One control row (Jay, 2026-09-26): search on the left, Set all on
          the right, both at the input's own height — no overrides. Set all
          applies to the tools currently listed, per group. */}
      {connector.actions.length > 0 ? (
        <div className="flex items-center gap-2">
          {connector.actions.length > SEARCH_THRESHOLD ? (
            <InputGroupSearch className="min-w-0 flex-1">
              <InputGroupSearchIcon>
                <MagnifyingGlassIcon />
              </InputGroupSearchIcon>
              <InputGroupSearchInput
                placeholder={tI18nComplete.raw('textfbd165231fa1')}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                variant="popover"
              />
              <InputGroupSearchClear onClick={() => setQuery('')} />
            </InputGroupSearch>
          ) : (
            <div className="flex-1" />
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                className="shrink-0 gap-1.5"
                disabled={
                  frozen || busy || groups.every((group) => bulkPathsFor(group).length === 0)
                }
              >
                {tI18nComplete.raw('textd9d0b4384a58')}
                <CaretDownIcon className="text-muted-foreground size-3.5 shrink-0" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-44 rounded-lg">
              {groups.map((group, index) => (
                <DropdownMenuGroup key={group.key}>
                  {index > 0 ? <DropdownMenuSeparator /> : null}
                  <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">
                    {group.label} · {group.actions.length}
                  </DropdownMenuLabel>
                  {policySegments.map((segment) => (
                    <DropdownMenuItem
                      key={segment.choice}
                      disabled={bulkPathsFor(group).length === 0}
                      onSelect={() => setBulk({ group, choice: segment.choice })}
                    >
                      {segment.label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuGroup>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ) : null}

      {projectLockedCount > 0 ? (
        <InfoBanner
          tone="warning"
          icon={LockIcon}
          title={tI18nComplete('textd3d900c89bd0', {
            value0: projectLockedCount,
            value1:
              projectLockedCount === 1
                ? tI18nComplete.raw('text86ca67d2851a')
                : tI18nComplete.raw('textd50ab26e1621'),
          })}
        >
          {tI18nComplete.raw('textf7d6d7f585c5')}
        </InfoBanner>
      ) : null}

      {policiesQuery.isPending ? (
        <div className="space-y-2">
          {[0, 1, 2].map((row) => (
            <Skeleton key={row} className="h-14 rounded-md" />
          ))}
        </div>
      ) : policiesQuery.isError ? (
        <ErrorState
          size="sm"
          title={tI18nComplete.raw('textff6065190563')}
          description={
            policiesQuery.error instanceof Error
              ? policiesQuery.error.message
              : tI18nComplete.raw('texta47c08d35337')
          }
          action={
            <Button variant="outline" size="sm" onClick={() => void policiesQuery.refetch()}>
              {tI18nComplete.raw('text942087cc2d41')}
            </Button>
          }
        />
      ) : connector.actions.length ===
        0 ? null : groups // page explains the failure (Jay, 2026-09-14). // No tools reported (failed or pending sync): show NOTHING here — the
        .length === 0 ? (
        <CatalogNoMatch query={query} />
      ) : (
        <div className="space-y-3">
          {allGroups.map((wholeGroup) => {
            const group = groups.find((candidate) => candidate.key === wholeGroup.key);
            if (!group) return null;
            return (
              <Disclosure
                // Remounts when a search starts or clears, so `defaultOpen`
                // re-applies: searching opens every group with matches.
                key={`${group.key}:${query.trim() ? 'search' : 'all'}`}
                // Writes are the decision that matters, so they start open.
                // A search opens every group that still has matches.
                defaultOpen={group.key === 'write' || query.trim().length > 0}
                className="group/tools bg-popover overflow-hidden rounded-md border"
              >
                <DisclosureTrigger>
                  <div className="hover:bg-hover focus-visible:ring-ring flex w-full cursor-pointer items-center gap-2.5 px-4 py-3 outline-none focus-visible:ring-2 focus-visible:ring-inset">
                    <div className="min-w-0 flex-1">
                      <p className="text-foreground text-sm font-medium">{group.label}</p>
                      <p className="text-muted-foreground mt-0.5 truncate text-xs">
                        {group.key === 'read'
                          ? tI18nComplete('text490efa0892f2', { value0: displayName })
                          : tI18nComplete('textda90bc82f00d', { value0: displayName })}
                      </p>
                    </div>
                    <Badge variant="secondary" size="tabular">
                      {query.trim()
                        ? `${group.actions.length}/${wholeGroup.actions.length}`
                        : wholeGroup.actions.length}
                    </Badge>
                    <CaretDownIcon className="text-muted-foreground duration-moderate size-3.5 shrink-0 transition-transform ease-out group-data-[state=open]/tools:rotate-180 motion-reduce:transition-none" />
                  </div>
                </DisclosureTrigger>
                <DisclosureContent>
                  <ul className="divide-y border-t">
                    {group.actions.map((action) => {
                      const locked = isLockedByProject(action.path, effective);
                      const row = toolRowText(action);
                      // The tool's own identifier leads, in mono — it is what
                      // the agent calls and what pattern rules match.
                      const subtitle = row.description ?? (row.path ? row.title : null);
                      return (
                        <li
                          key={action.path}
                          className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3"
                        >
                          <div className="min-w-0 flex-1 basis-48">
                            <p className="text-foreground truncate font-mono text-sm">
                              {action.path}
                            </p>
                            {subtitle ? (
                              <p className="text-muted-foreground line-clamp-2 text-xs text-pretty">
                                {subtitle}
                              </p>
                            ) : null}
                          </div>
                          <ToolPolicyControl
                            label={tI18nComplete('textb34f1e3c1569', {
                              value0: row.path ?? row.title,
                            })}
                            value={toolChoice(action.path, policies, effective)}
                            onChange={(next) => setToolPolicy(action.path, next)}
                            disabled={frozen || busy}
                            lockedReason={locked ? LOCKED_REASON : undefined}
                            defaultHint={describeToolDefault(
                              connector.sensitive === true,
                              policiesQuery.data?.default_mode,
                              action.risk,
                            )}
                          />
                        </li>
                      );
                    })}
                  </ul>
                </DisclosureContent>
              </Disclosure>
            );
          })}
        </div>
      )}

      <div className="bg-popover flex items-center gap-3.5 rounded-md border px-4 py-3.5">
        <div className="min-w-0 flex-1">
          <p className="text-foreground text-sm font-medium">
            {tI18nComplete.raw('text594bdd4c19b2')}
          </p>
          <p className="text-muted-foreground mt-0.5 text-xs text-pretty">
            {tI18nComplete.raw('textf900377c2048')}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {sensitiveMutation.isPending ? <Loading className="size-4 shrink-0" /> : null}
          <Switch
            checked={connector.sensitive === true}
            onCheckedChange={(next) => sensitiveMutation.mutate(next)}
            disabled={frozen || sensitiveMutation.isPending}
            aria-label={tI18nComplete.raw('text594bdd4c19b2')}
          />
        </div>
      </div>

      {/* Pattern rules: always last, always present (Jay, 2026-09-26) — a
          disclosure so a connector without rules stays one quiet row, open
          by default once rules exist so they are never hidden. */}
      <Disclosure
        key={advancedRules.length > 0 ? 'has-rules' : 'no-rules'}
        defaultOpen={advancedRules.length > 0}
        className="group/rules bg-popover overflow-hidden rounded-md border"
      >
        <DisclosureTrigger>
          <div className="hover:bg-hover focus-visible:ring-ring flex w-full cursor-pointer items-center gap-2.5 px-4 py-3 outline-none focus-visible:ring-2 focus-visible:ring-inset">
            <div className="min-w-0 flex-1">
              <p className="text-foreground text-sm font-medium">
                {tI18nComplete.raw('text380c0b05bcfc')}
              </p>
            </div>
            <Badge variant="secondary" size="tabular">
              {advancedRules.length}
            </Badge>
            <CaretDownIcon className="text-muted-foreground duration-moderate size-3.5 shrink-0 transition-transform ease-out group-data-[state=open]/rules:rotate-180 motion-reduce:transition-none" />
          </div>
        </DisclosureTrigger>
        <DisclosureContent>
          <div className="space-y-3 border-t px-4 py-3.5">
            <p className="text-muted-foreground text-xs text-pretty">
              {tI18nComplete.raw('textde00adeaf21b')}
              <code className="font-mono">delete_*</code>
              {tI18nComplete.raw('text3a13855164e7')}
              <code className="font-mono">/^send/i</code>
              {tI18nComplete.raw('texte45481e75a5e')}
            </p>
            {draft.length > 0 ? (
              <ul className="space-y-2">
                {draft.map((row) => (
                  <li key={row.id} className="flex items-center gap-2">
                    <Input
                      value={row.match}
                      placeholder={tI18nComplete.raw('text74ad536dca05')}
                      variant="popover"
                      size="xs"
                      className="flex-1 font-mono"
                      aria-label={tI18nComplete.raw('text5c9c672f4cd3')}
                      disabled={frozen}
                      onChange={(event) =>
                        setDraft((rows) =>
                          rows.map((candidate) =>
                            candidate.id === row.id
                              ? { ...candidate, match: event.target.value }
                              : candidate,
                          ),
                        )
                      }
                    />
                    <Select
                      value={row.action}
                      disabled={frozen}
                      onValueChange={(next) =>
                        setDraft((rows) =>
                          rows.map((candidate) =>
                            candidate.id === row.id
                              ? { ...candidate, action: next as ConnectorPolicyAction }
                              : candidate,
                          ),
                        )
                      }
                    >
                      <SelectTrigger className="h-8 w-[104px] shrink-0 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      {/* Three, not four: a stored rule always names an action.
                          "Default" for a pattern means deleting it, which is
                          what the remove button beside this does. */}
                      <SelectContent className="rounded-lg">
                        {(
                          ['block', 'require_approval', 'always_run'] as ConnectorPolicyAction[]
                        ).map((action) => (
                          <SelectItem key={action} value={action} className="text-xs">
                            {POLICY_CHOICE_LABEL[action]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="text-muted-foreground hover:text-destructive size-8 shrink-0"
                      aria-label={tI18nComplete('texte2cbd4618228', {
                        value0: row.match || '(empty)',
                      })}
                      disabled={frozen}
                      onClick={() =>
                        setDraft((rows) => rows.filter((candidate) => candidate.id !== row.id))
                      }
                    >
                      <XIcon className="size-3.5 shrink-0" />
                    </Button>
                  </li>
                ))}
              </ul>
            ) : null}
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5"
                disabled={frozen}
                onClick={() =>
                  setDraft((rows) => [
                    ...rows,
                    { id: nextPatternRowId(), match: '', action: 'require_approval' },
                  ])
                }
              >
                <PlusIcon className="size-3.5 shrink-0" />
                {tI18nComplete.raw('texta27cff51a2e0')}
              </Button>
              {advancedDirty ? (
                <div className="ml-auto flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline-ghost"
                    disabled={busy}
                    onClick={() => setDraft(seedPatternDraft(advancedRules, nextPatternRowId))}
                  >
                    {tI18nComplete.raw('texteb1a70e39274')}
                  </Button>
                  <Button
                    size="sm"
                    className="gap-1.5"
                    disabled={frozen || busy}
                    onClick={savePatternRules}
                  >
                    {writePolicies.isPending ? <Loading className="size-3.5 shrink-0" /> : null}
                    {tI18nComplete.raw('texte5dbdffb8816')}
                  </Button>
                </div>
              ) : null}
            </div>
          </div>
        </DisclosureContent>
      </Disclosure>

      <ConfirmDialog
        open={bulk !== null}
        onOpenChange={(open) => {
          if (!open) setBulk(null);
        }}
        title={bulk ? bulkConfirmTitle(bulkPaths.length, bulk.choice) : ''}
        description={bulk ? bulkConfirmDescription(bulk.group.label, bulk.choice) : ''}
        confirmLabel={
          bulk
            ? bulk.choice === 'default'
              ? tI18nComplete.raw('text1707565fd3f0')
              : tI18nComplete('text41ffc5e14073', { value0: POLICY_CHOICE_LABEL[bulk.choice] })
            : 'Confirm'
        }
        isPending={writePolicies.isPending}
        onConfirm={() => {
          if (!bulk) return;
          writePolicies.mutate({
            rules: applyBulkPolicy(policies, bulkPaths, bulk.choice),
            paths: bulkPaths,
            choice: bulk.choice,
          });
          setBulk(null);
        }}
      />
    </div>
  );
}

/** "Set 10 tools to Block?" does not describe clearing them, so Default gets
 *  its own sentence rather than a label substituted into the wrong verb. */
function bulkConfirmTitle(count: number, choice: PolicyChoice): string {
  const tools = `${count} ${count === 1 ? 'tool' : 'tools'}`;
  return choice === 'default'
    ? `Return ${tools} to the connector default?`
    : `Set ${tools} to ${POLICY_CHOICE_LABEL[choice]}?`;
}

function bulkConfirmDescription(groupLabel: string, choice: PolicyChoice): string {
  const tail = 'Pattern rules are left alone, and you can change any tool individually afterwards.';
  return choice === 'default'
    ? `Deletes the per-tool rule for every tool listed under ${groupLabel} right now, so each one follows the connector default again. ${tail}`
    : `Every tool listed under ${groupLabel} right now is set to ${POLICY_CHOICE_LABEL[choice]}. ${tail}`;
}

/** The same answer for one row, so an unlit control still says what it does. */
function describeToolDefault(
  sensitive: boolean,
  defaultMode: 'risk' | 'allow_all' | undefined,
  risk: 'read' | 'write' | 'destructive',
): string {
  if (sensitive) return 'Following the connector default — asks before it runs.';
  if (defaultMode === 'allow_all') return 'Following the connector default — runs without asking.';
  return risk === 'read'
    ? 'Following the connector default — runs without asking.'
    : 'Following the connector default — asks before it runs.';
}
