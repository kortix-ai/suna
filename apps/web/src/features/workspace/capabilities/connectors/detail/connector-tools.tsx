'use client';
import { ConnectorAdvancedTools } from './connector-advanced-tools';

import { useLocalizedUiCatalog } from '@/i18n/use-localized-ui-catalog';
import { useTranslations } from '@/i18n/use-translations';
import {
  type AdminConnector,
  type ConnectorPolicyRule,
  getConnectorPolicies,
  setConnectorPolicies,
  setConnectorSensitive,
} from '@kortix/sdk';
import {
  CaretDownIcon,
  CaretRightIcon,
  LockIcon,
  MagnifyingGlassIcon,
  WrenchIcon,
} from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { CountBadge } from '@/components/ui/count-badge';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { InfoBanner } from '@/components/ui/info-banner';
import {
  InputGroupSearch,
  InputGroupSearchClear,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from '@/components/ui/input-group';
import { Skeleton } from '@/components/ui/skeleton';
import { errorToast, successToast } from '@/components/ui/toast';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';

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

interface ConnectorToolsProps {
  projectId: string;
  connector: AdminConnector;
  displayName: string;
  canWrite: boolean;
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
 * Everything else — the `sensitive` toggle and the pattern-rule editor — is
 * folded into **Advanced**. Both are real capabilities carried over from the
 * shipped panel; they are just not the common case.
 *
 * A connector that has reported no tools shows one empty state and nothing
 * else: there is nothing to decide about tools that do not exist yet. Each
 * group is a disclosure, open by default, so a long write list can be folded
 * away while the read list is being set.
 */
export function ConnectorTools({
  projectId,
  connector,
  displayName,
  canWrite,
  onChanged,
}: ConnectorToolsProps) {
  const t = useTranslations('connectorPages');
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
  const frozen = !canWrite;

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

  if (!canWrite) {
    return (
      <p className="text-muted-foreground text-sm text-pretty">
        {tI18nComplete.raw('textdb7d057a2f68')} {displayName}{' '}
        {tI18nComplete.raw('text24984f203fd7')}
      </p>
    );
  }

  const hasTools = connector.actions.length > 0;

  return (
    <div className="space-y-5">
      {hasTools ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-muted-foreground min-w-0 text-sm text-pretty">
            {describeDefault(connector.sensitive === true, policiesQuery.data?.default_mode)}
          </p>
          {connector.actions.length > SEARCH_THRESHOLD ? (
            <InputGroupSearch className="w-full sm:max-w-64">
              <InputGroupSearchIcon>
                <MagnifyingGlassIcon />
              </InputGroupSearchIcon>
              <InputGroupSearchInput
                placeholder={tI18nComplete.raw('textfbd165231fa1')}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                variant="popover"
                size="sm"
              />
              <InputGroupSearchClear onClick={() => setQuery('')} />
            </InputGroupSearch>
          ) : null}
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
      ) : !hasTools ? (
        // The connector exists but has reported no tools — a failed or pending
        // sync. That is a different statement from "nothing matched your
        // search", and it must not render as a blank panel.
        <EmptyState
          icon={WrenchIcon}
          size="sm"
          title={tI18nComplete.raw('text99dd86336467')}
          description={t('toolsEmptyBody', { name: displayName })}
        />
      ) : groups.length === 0 ? (
        // The same line the four catalogs render, from the same component.
        // What was searched is unambiguous here — the box above says "Search
        // 19 tools" — so a second wording for one outcome bought nothing.
        <CatalogNoMatch query={query} />
      ) : (
        <div className="space-y-2">
          {groups.map((group) => (
            <Disclosure key={group.key} variant="outline" className="overflow-hidden" defaultOpen>
              <div className="flex items-center gap-2 pr-2">
                <DisclosureTrigger variant="outline">
                  <Button
                    variant="popover"
                    className="flex min-w-0 flex-1 items-center justify-start rounded-none"
                  >
                    <CaretRightIcon className="text-muted-foreground size-3.5 shrink-0 transition-transform duration-(--duration-normal) ease-out group-data-[state=open]:rotate-90 motion-reduce:transition-none" />
                    <span className="truncate text-sm font-medium">{group.label}</span>
                    <CountBadge count={group.actions.length} />
                  </Button>
                </DisclosureTrigger>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="shrink-0"
                      disabled={frozen || busy || bulkPathsFor(group).length === 0}
                    >
                      {tI18nComplete.raw('textd9d0b4384a58')}
                      <CaretDownIcon className="size-3.5 shrink-0" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="min-w-32">
                    {policySegments.map((segment) => (
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
              <DisclosureContent variant="outline" contentClassName="border-border border-t">
                <ul className="divide-border/60 divide-y px-4">
                  {group.actions.map((action) => {
                    const locked = isLockedByProject(action.path, effective);
                    const row = toolRowText(action);
                    return (
                      <li
                        key={action.path}
                        className="flex flex-wrap items-start gap-x-4 gap-y-2 py-3"
                      >
                        <div className="min-w-0 flex-1 basis-48 space-y-0.5">
                          <p className="text-foreground text-sm font-medium wrap-break-word">
                            {row.title}
                          </p>
                          {row.description ? (
                            <p className="text-muted-foreground line-clamp-2 text-xs text-pretty">
                              {row.description}
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
          ))}
        </div>
      )}

      <ConnectorAdvancedTools
        connector={connector}
        advancedRules={advancedRules}
        toolRules={toolRules}
        loaded={!!policiesQuery.data}
        frozen={frozen}
        busy={busy}
        saving={writePolicies.isPending}
        sensitivePending={sensitiveMutation.isPending}
        onSave={(rules) => writePolicies.mutate({ rules })}
        onSensitive={(next) => sensitiveMutation.mutate(next)}
      />

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
