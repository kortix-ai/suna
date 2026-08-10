'use client';

import {
  type WorkspaceAdminConnector,
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
  TrashIcon,
  WrenchIcon,
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
  DropdownMenuItem,
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
import { Switch } from '@/components/ui/switch';
import { errorToast, successToast } from '@/components/ui/toast';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';

import { providerLabel } from '@/features/workspace/capabilities/connectors/provider-label';
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
  isLockedByWorkspace,
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
  'A workspace rule already decides this tool. Change it under Global rules in the capability tabs.';

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
  workspaceId: string;
  connector: WorkspaceAdminConnector;
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
 * 3. **A workspace rule is not editable here.** Workspace scope is evaluated first
 *    and wins (`resolveEffectiveAction`, connectors/policy.ts:342), so those rows
 *    are disabled and say where the rule actually lives.
 *
 * Everything else — the `sensitive` toggle and the pattern-rule editor — is
 * folded into **Advanced**. Both are real capabilities carried over from the
 * shipped panel; they are just not the common case.
 */
export function ConnectorTools({
  workspaceId,
  connector,
  displayName,
  canWrite,
  disabled,
  onChanged,
}: ConnectorToolsProps) {
  const queryClient = useQueryClient();
  const slug = connector.slug;
  const queryKey = useMemo(() => ['connector-policies', workspaceId, slug], [workspaceId, slug]);

  // Reading policies is admin-gated on the server (`resolveAdmin`,
  // connectors/router.ts:1193), so a reader would get a 403 and a permanent
  // skeleton. `connectorTabs` already hides this tab from them; the guard
  // below keeps that true if it ever stops doing so.
  const policiesQuery = useQuery({
    queryKey,
    queryFn: () => getConnectorPolicies(workspaceId, slug),
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
  const groups = useMemo(() => groupToolsByRisk(matches), [matches]);

  const workspaceLockedCount = useMemo(
    () => effective.filter((entry) => entry.source === 'workspace').length,
    [effective],
  );

  const writePolicies = useMutation<
    Awaited<ReturnType<typeof setConnectorPolicies>>,
    Error,
    PolicyWrite,
    { previous: PoliciesData | undefined }
  >({
    mutationFn: (write) => setConnectorPolicies(workspaceId, slug, orderPolicyRules(write.rules)),
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
      errorToast(error.message || 'Failed to update permissions');
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey });
    },
  });

  const sensitiveMutation = useMutation({
    mutationFn: (next: boolean) => setConnectorSensitive(workspaceId, slug, next),
    onSuccess: (_result, next) => {
      successToast(
        next ? 'Every tool will ask before it runs' : 'Tools follow the rules below again',
      );
      void queryClient.invalidateQueries({ queryKey });
      onChanged();
    },
    onError: (error: Error) => errorToast(error.message || 'Failed to update'),
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
  // exact count. Workspace-locked paths are excluded: writing a connector rule
  // under a workspace rule changes nothing.
  const [bulk, setBulk] = useState<{ group: ToolGroup; choice: PolicyChoice } | null>(null);
  const bulkPathsFor = (group: ToolGroup) =>
    group.actions
      .map((action) => action.path)
      .filter((path) => !isLockedByWorkspace(path, effective));
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

  const [advancedOpen, setAdvancedOpen] = useState(connector.actions.length === 0);
  useEffect(() => {
    if (advancedRules.length > 0) setAdvancedOpen(true);
  }, [advancedRules.length]);

  const savePatternRules = () =>
    writePolicies.mutate({ rules: [...toolRules, ...draftToRules(draft)] });

  if (!canWrite) {
    return (
      <p className="text-muted-foreground text-sm text-pretty">
        What agents may do with {displayName} is set by a workspace manager. You do not have
        permission to change it.
      </p>
    );
  }

  const providerBadge = providerLabel(connector.provider);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0 space-y-0.5">
          <h3 className="text-foreground text-lg font-semibold text-balance">Tools</h3>
          <p className="text-muted-foreground text-sm text-pretty">
            {describeDefault(connector.sensitive === true, policiesQuery.data?.default_mode)}
          </p>
        </div>
        {connector.actions.length > SEARCH_THRESHOLD ? (
          <InputGroupSearch className="w-full sm:max-w-64">
            <InputGroupSearchIcon>
              <MagnifyingGlassIcon />
            </InputGroupSearchIcon>
            <InputGroupSearchInput
              placeholder="Search tools"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              variant="popover"
            />
            <InputGroupSearchClear onClick={() => setQuery('')} />
          </InputGroupSearch>
        ) : null}
      </div>

      {workspaceLockedCount > 0 ? (
        <InfoBanner
          tone="warning"
          icon={LockIcon}
          title={`${workspaceLockedCount} ${workspaceLockedCount === 1 ? 'tool is' : 'tools are'} decided by a workspace rule`}
        >
          Workspace rules apply to every connector and are evaluated first, so those tools cannot be
          changed here. Edit them under Global rules in the capability tabs.
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
          title="Couldn’t load permissions"
          description={
            policiesQuery.error instanceof Error
              ? policiesQuery.error.message
              : 'The permission rules for this connector could not be read.'
          }
          action={
            <Button variant="outline" size="sm" onClick={() => void policiesQuery.refetch()}>
              Retry
            </Button>
          }
        />
      ) : connector.actions.length === 0 ? (
        // The connector exists but has reported no tools — a failed or pending
        // sync. That is a different statement from "nothing matched your
        // search", and it must not render as a blank panel.
        <EmptyState
          icon={WrenchIcon}
          size="sm"
          title="No tools yet"
          description={`${displayName} hasn’t reported any tools. Once it syncs, each one gets its own Default · Block · Ask · Allow control here.`}
        />
      ) : groups.length === 0 ? (
        // The same line the four catalogs render, from the same component.
        // What was searched is unambiguous here — the box above says "Search
        // 19 tools" — so a second wording for one outcome bought nothing.
        <CatalogNoMatch query={query} />
      ) : (
        groups.map((group) => (
          <section key={group.key} className="space-y-1">
            <div className="flex items-center justify-between gap-2 py-1">
              <div className="flex items-center gap-2">
                {/* <CaretDownIcon className="text-muted-foreground size-3.5 shrink-0" /> */}
                <Label className="text-sm font-medium">{group.label}</Label>
                <Badge variant="secondary" size="tabular">
                  {group.actions.length}
                </Badge>
              </div>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={frozen || busy || bulkPathsFor(group).length === 0}
                  >
                    Set all
                    <CaretDownIcon className="size-3.5 shrink-0" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-32 rounded-lg">
                  {POLICY_SEGMENTS.map((segment) => (
                    <DropdownMenuItem
                      key={segment.choice}
                      onSelect={() => setBulk({ group, choice: segment.choice })}
                    >
                      {segment.label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>

            <ul className="divide-border/60 divide-y border-y">
              {group.actions.map((action) => {
                const locked = isLockedByWorkspace(action.path, effective);
                const row = toolRowText(action);
                return (
                  <li
                    key={action.path}
                    className="flex flex-wrap items-start gap-x-4 gap-y-2 py-3.5"
                  >
                    <div className="min-w-0 flex-1 basis-48 space-y-1">
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <span className="text-foreground text-sm font-medium">{row.title}</span>
                        <Badge variant="secondary" size="xs">
                          {providerBadge}
                        </Badge>
                      </div>
                      {row.description ? (
                        <p className="text-muted-foreground line-clamp-2 text-sm text-pretty">
                          {row.description}
                        </p>
                      ) : null}
                    </div>
                    <ToolPolicyControl
                      label={`Permission for ${row.path ?? row.title}`}
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
          </section>
        ))
      )}

      <Disclosure
        variant="outline"
        className="overflow-hidden"
        open={advancedOpen}
        onOpenChange={setAdvancedOpen}
      >
        <DisclosureTrigger variant="outline">
          <Button variant="popover">
            Advanced
            {advancedRules.length > 0 ? (
              <Badge variant="secondary" size="sm">
                {advancedRules.length}
              </Badge>
            ) : null}
            <span className="text-muted-foreground ml-auto text-xs font-normal">
              Ask before every use · pattern rules
            </span>
          </Button>
        </DisclosureTrigger>
        <DisclosureContent variant="outline" contentClassName="border-border border-t">
          <div className="space-y-5 px-4 py-5">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="text-foreground text-sm font-medium">Ask before every use</p>
                <p className="text-muted-foreground mt-0.5 text-xs text-pretty">
                  Every tool asks for approval, including reads. For mail, files or secrets, where
                  reading is itself risky. A rule above can still open one tool.
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {sensitiveMutation.isPending ? <Loading className="size-4 shrink-0" /> : null}
                <Switch
                  checked={connector.sensitive === true}
                  onCheckedChange={(next) => sensitiveMutation.mutate(next)}
                  disabled={frozen || sensitiveMutation.isPending}
                  aria-label="Ask before every use"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label>Pattern rules</Label>
              <p className="text-muted-foreground text-xs text-pretty">
                Cover many tools at once with a glob (<code className="font-mono">delete_*</code>)
                or a regex (<code className="font-mono">/^send/i</code>). A per-tool decision above
                always wins over a pattern.
              </p>
              {draft.map((row) => (
                <div key={row.id} className="flex items-center gap-2">
                  <Input
                    value={row.match}
                    placeholder="delete_*"
                    variant="popover"
                    size="xs"
                    className="flex-1 font-mono"
                    aria-label="Rule pattern"
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
                        what the trash button beside this does. */}
                    <SelectContent className="rounded-lg">
                      {(['block', 'require_approval', 'always_run'] as ConnectorPolicyAction[]).map(
                        (action) => (
                          <SelectItem key={action} value={action} className="text-xs">
                            {POLICY_CHOICE_LABEL[action]}
                          </SelectItem>
                        ),
                      )}
                    </SelectContent>
                  </Select>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="hover:text-destructive size-8 shrink-0"
                    aria-label={`Remove rule ${row.match || '(empty)'}`}
                    disabled={frozen}
                    onClick={() =>
                      setDraft((rows) => rows.filter((candidate) => candidate.id !== row.id))
                    }
                  >
                    <TrashIcon className="size-3.5 shrink-0" />
                  </Button>
                </div>
              ))}
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 gap-1.5 text-xs"
                  disabled={frozen}
                  onClick={() =>
                    setDraft((rows) => [
                      ...rows,
                      { id: nextPatternRowId(), match: '', action: 'require_approval' },
                    ])
                  }
                >
                  <PlusIcon className="size-3.5 shrink-0" />
                  Add rule
                </Button>
                {advancedDirty ? (
                  <div className="ml-auto flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline-ghost"
                      className="h-8 text-xs"
                      disabled={busy}
                      onClick={() => setDraft(seedPatternDraft(advancedRules, nextPatternRowId))}
                    >
                      Discard
                    </Button>
                    <Button
                      size="sm"
                      className="h-8 gap-1.5 text-xs"
                      disabled={frozen || busy}
                      onClick={savePatternRules}
                    >
                      {writePolicies.isPending ? <Loading className="size-3.5 shrink-0" /> : null}
                      Save rules
                    </Button>
                  </div>
                ) : null}
              </div>
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
              ? 'Return to default'
              : `Set to ${POLICY_CHOICE_LABEL[bulk.choice]}`
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

/**
 * What happens to a tool nobody has decided on — read off the server's own
 * answer, never guessed. `sensitive` beats `default_mode` at the gate
 * (`resolveEffectiveAction`, connectors/policy.ts:362), so it is stated first.
 */
function describeDefault(
  sensitive: boolean,
  defaultMode: 'risk' | 'allow_all' | undefined,
): string {
  if (sensitive) {
    return 'Every tool asks for approval before it runs, including reads. Set a tool below to change that.';
  }
  if (defaultMode === 'allow_all') {
    return 'Every tool runs without asking unless you decide otherwise below.';
  }
  return 'Reads run without asking; writes and deletes ask first. Decide any tool below.';
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
