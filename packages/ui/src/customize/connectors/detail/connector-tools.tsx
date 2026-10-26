'use client';
import { ConnectorAdvancedTools } from './connector-advanced-tools';
import { ConnectorPolicySetBar } from './connector-policy-sets';

import { useLocalizedUiCatalog } from '../../../i18n/ui-catalog/use-localized-ui-catalog';
import { useTranslations } from '../../../i18n';
import {
  type AdminConnector,
  type ConnectorAction,
  type ConnectorPolicyAction,
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
import { useCallback, useMemo, useState } from 'react';

import { Button } from '../../../primitives/button';
import { ConfirmDialog } from '../../../primitives/confirm-dialog';
import { CountBadge } from '../../../primitives/count-badge';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '../../../primitives/disclosure';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../../primitives/dropdown-menu';
import { InfoBanner } from '../../../primitives/info-banner';
import {
  InputGroupSearch,
  InputGroupSearchClear,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from '../../../primitives/input-group';
import { Skeleton } from '../../../primitives/skeleton';
import { cn } from '../../../internal/lib/utils';
import { errorToast, successToast } from '../../../primitives/toast';
import { EmptyState } from '../../../primitives/empty-state';
import { ErrorState } from '../../../primitives/error-state';
import Hint from '../../../primitives/hint';
import { Switch } from '../../../primitives/switch';

import {
  filterActions,
  groupToolsByRisk,
  type ToolGroup,
  toolRowText,
} from '../tools/tool-groups';
import {
  applyBulkPolicy,
  connectorDefaultAction,
  inheritedAction,
  isAdvancedRule,
  isLockedByProject,
  orderPolicyRules,
  type PolicyChoice,
  type PolicyScope,
  previewEffective,
  summarizeToolDecisions,
  toolChoice,
} from '../tools/tool-policy';
import { connectorPoliciesKey, supportsPolicySets } from '../tools/policy-sets';
import { ToolPolicyControl } from '../tools/tool-policy-control';
import {
  POLICY_CHOICE_LABEL,
  POLICY_SEGMENTS,
} from '../tools/tool-policy-labels';
import { CatalogNoMatch } from '../../shared/catalog/catalog-empty-state';
import { UiLink as Link } from '../../../providers/ui-provider';
import { rulesHref } from '../connector-routes';

/** Below this many tools the search field is clutter; above it the list is
 *  unusable without one. */
const SEARCH_THRESHOLD = 6;

const POLICY_QUERY_STALE_MS = 5_000;


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
 * 1. **Read, write, unclassified.** `groupToolsByRisk` folds `destructive`
 *    into writes, and a tool nobody classified gets its own group instead of
 *    passing for a write.
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
  const tSets = useTranslations('connectorPolicySets');
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const policySegments = useLocalizedUiCatalog(POLICY_SEGMENTS);
  const queryClient = useQueryClient();
  const slug = connector.slug;
  // Null edits the base rules; a name edits that policy set's rules. The
  // query key carries it, so each list caches on its own.
  const [policySet, setPolicySet] = useState<string | null>(null);
  const onPolicySet = useCallback((next: string | null) => setPolicySet(next), []);
  const scope: PolicyScope = policySet ? 'set' : 'base';
  const showSets = supportsPolicySets(connector.provider);
  const queryKey = useMemo(
    () => connectorPoliciesKey(projectId, slug, policySet),
    [projectId, slug, policySet],
  );

  // Reading policies is admin-gated on the server (`resolveAdmin`,
  // connectors/router.ts:1193), so a reader would get a 403 and a permanent
  // skeleton. `connectorTabs` already hides this tab from them; the guard
  // below keeps that true if it ever stops doing so.
  const policiesQuery = useQuery({
    queryKey,
    queryFn: () => getConnectorPolicies(projectId, slug, { policySet: policySet ?? undefined }),
    staleTime: POLICY_QUERY_STALE_MS,
    enabled: canWrite,
  });

  // In a set, Inherit names what the base rules decide. Same key and fetch as
  // the base view and the rule-set strip: one cached request.
  const baseQuery = useQuery({
    queryKey: connectorPoliciesKey(projectId, slug, null),
    queryFn: () => getConnectorPolicies(projectId, slug, { policySet: undefined }),
    staleTime: POLICY_QUERY_STALE_MS,
    enabled: canWrite && scope === 'set',
  });
  const baseEffective = useMemo(() => baseQuery.data?.effective ?? [], [baseQuery.data]);

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
    () => policies.filter((rule) => !isAdvancedRule(rule) && toolPaths.has(rule.match)),
    [policies, toolPaths],
  );
  const advancedRules = useMemo(
    () => policies.filter((rule) => isAdvancedRule(rule) || !toolPaths.has(rule.match)),
    [policies, toolPaths],
  );

  const sensitive = connector.sensitive === true;
  const defaultMode = policiesQuery.data?.default_mode;
  const fallback = useCallback(
    (action: ConnectorAction) => connectorDefaultAction(sensitive, defaultMode, action.risk),
    [sensitive, defaultMode],
  );
  const summary = useMemo(
    () => summarizeToolDecisions(connector.actions, policies, effective, scope, fallback),
    [connector.actions, policies, effective, scope, fallback],
  );
  // The first word of a name is the app: `LINEAR_ARCHIVE_ISSUE` reads
  // "Archive issue" on the Linear page.
  const appNames = useMemo(
    () => [slug, connector.name, displayName, slug.split('-')[0] ?? ''],
    [slug, connector.name, displayName],
  );

  const [query, setQuery] = useState('');
  const [onlyChanged, setOnlyChanged] = useState(false);
  const matches = useMemo(() => {
    const found = filterActions(connector.actions, query);
    if (!onlyChanged) return found;
    return found.filter(
      (action) =>
        toolChoice(action.path, policies, effective, scope) !== 'default' &&
        !isLockedByProject(action.path, effective),
    );
  }, [connector.actions, query, onlyChanged, policies, effective, scope]);
  const groups = useMemo(
    () => groupToolsByRisk(matches, tI18nComplete, appNames),
    [matches, tI18nComplete, appNames],
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
    mutationFn: (write) =>
      setConnectorPolicies(projectId, slug, orderPolicyRules(write.rules), {
        policySet: policySet ?? undefined,
      }),
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
                  ? previewEffective(old.effective ?? [], write.paths, write.choice, scope)
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
  const choiceLabel = (choice: PolicyChoice) =>
    choice === 'default' && scope === 'set' ? tSets('inherit') : POLICY_CHOICE_LABEL[choice];
  const decisionWord = (action: ConnectorPolicyAction) =>
    action === 'block'
      ? t('toolsDecisionBlocked')
      : action === 'require_approval'
        ? t('toolsDecisionAsks')
        : t('toolsDecisionRuns');
  const inheritLabel = (path: string, choice: PolicyChoice, action: ConnectorAction) => {
    const resolved = decisionWord(
      inheritedAction(path, choice, effective, baseEffective, scope, fallback(action)),
    );
    return scope === 'set'
      ? t('toolsInheritAs', { action: resolved })
      : t('toolsDefaultAs', { action: resolved });
  };
  // What decides a tool left on Default/Inherit, named the way the page names
  // it: the base rules, the sensitive flag, or the project's default mode.
  const decidedBy = (path: string) => {
    const entry = (scope === 'set' ? baseEffective : effective).find((e) => e.path === path);
    if (scope === 'set' && entry?.source !== 'risk_default' && entry?.source !== 'allow_all') {
      return t('toolsFromBase');
    }
    if (entry?.source === 'connector') return t('toolsFromBase');
    if (sensitive) return t('toolsFromSensitive');
    return t('toolsFromDefault');
  };
  const summaryParts = [
    t('toolsSummaryTotal', { count: summary.total }),
    summary.block > 0 ? t('toolsSummaryBlocked', { count: summary.block }) : null,
    summary.ask > 0 ? t('toolsSummaryAsk', { count: summary.ask }) : null,
    summary.run > 0 ? t('toolsSummaryRun', { count: summary.run }) : null,
  ].filter(Boolean);

  return (
    <div className="space-y-5">
      {showSets ? (
        <ConnectorPolicySetBar
          projectId={projectId}
          slug={slug}
          canWrite={canWrite}
          value={policySet}
          onChange={onPolicySet}
        />
      ) : null}

      {hasTools && policiesQuery.data ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-muted-foreground min-w-0 text-sm tabular-nums">
            {summaryParts.join(' · ')}
          </p>
          <div className="flex w-full flex-wrap items-center gap-3 sm:w-auto">
            {connector.actions.length > SEARCH_THRESHOLD ? (
              <InputGroupSearch className="w-full sm:w-56">
                <InputGroupSearchIcon>
                  <MagnifyingGlassIcon />
                </InputGroupSearchIcon>
                <InputGroupSearchInput
                  placeholder={tI18nComplete.raw('textfbd165231fa1')}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  size="sm"
                />
                <InputGroupSearchClear onClick={() => setQuery('')} />
              </InputGroupSearch>
            ) : null}
            <Switch
              label={t('toolsOnlyChanged')}
              checked={onlyChanged}
              onCheckedChange={setOnlyChanged}
              className="px-0 py-0"
            />
          </div>
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
          {t('toolsProjectLockedBody')}{' '}
          <Link
            href={rulesHref(projectId)}
            className="text-foreground underline underline-offset-4"
          >
            {t('toolsOpenRules')}
          </Link>
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
      ) : groups.length === 0 && onlyChanged && !query.trim() ? (
        <p className="text-muted-foreground py-6 text-center text-sm text-pretty">
          {scope === 'set' ? t('toolsNoneChangedSet') : t('toolsNoneChangedBase')}
        </p>
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
                        {segment.choice === 'default' ? choiceLabel('default') : segment.label}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              <DisclosureContent variant="outline" contentClassName="border-border border-t">
                <ul className="divide-border/60 divide-y px-4">
                  {group.actions.map((action) => {
                    const locked = isLockedByProject(action.path, effective);
                    const row = toolRowText(action, appNames);
                    const choice = toolChoice(action.path, policies, effective, scope);
                    const changed = choice !== 'default' && !locked;
                    return (
                      <li
                        key={action.path}
                        className="flex flex-wrap items-center gap-x-4 gap-y-2 py-2.5"
                      >
                        <div className="flex min-w-0 flex-1 basis-56 items-start gap-2">
                          {/* Every row keeps the marker's slot, so titles share one x. */}
                          <span className="flex h-5 shrink-0 items-center">
                            <span
                              className={cn('size-1.5 rounded-full', changed && 'bg-foreground')}
                            >
                              {changed ? <span className="sr-only">{t('toolsChanged')}</span> : null}
                            </span>
                          </span>
                          <div className="min-w-0 flex-1">
                            {/* Narrow: the id moves under the title instead of cutting it. */}
                            <div className="flex flex-wrap items-baseline gap-x-2">
                              <p className="text-foreground min-w-0 text-sm font-medium wrap-break-word">
                                {row.title}
                              </p>
                              {row.path ? (
                                <code className="text-muted-foreground max-w-full truncate font-mono text-xs">
                                  {row.path}
                                </code>
                              ) : null}
                            </div>
                            {choice === 'default' && !locked ? (
                              <p className="text-muted-foreground text-xs">
                                {decidedBy(action.path)}
                              </p>
                            ) : null}
                            {row.description ? (
                              <Hint label={row.description} side="bottom">
                                <p className="text-muted-foreground truncate text-xs">
                                  {row.description}
                                </p>
                              </Hint>
                            ) : null}
                          </div>
                        </div>
                        <ToolPolicyControl
                          label={tI18nComplete('textb34f1e3c1569', {
                            value0: row.path ?? row.title,
                          })}
                          value={choice}
                          onChange={(next) => setToolPolicy(action.path, next)}
                          disabled={frozen || busy}
                          lockedReason={locked ? t('toolsLockedByProject') : undefined}
                          defaultLabel={inheritLabel(action.path, choice, action)}
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
        key={policySet ?? 'base'}
        connector={connector}
        showSensitive={scope === 'base'}
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
        title={
          bulk
            ? bulk.choice === 'default' && scope === 'set'
              ? tSets('bulkInheritTitle', { count: bulkPaths.length })
              : bulkConfirmTitle(bulkPaths.length, bulk.choice)
            : ''
        }
        description={
          bulk
            ? bulk.choice === 'default' && scope === 'set'
              ? tSets('bulkInheritBody', { group: bulk.group.label })
              : bulkConfirmDescription(bulk.group.label, bulk.choice)
            : ''
        }
        confirmLabel={
          bulk
            ? bulk.choice === 'default'
              ? scope === 'set'
                ? tSets('inherit')
                : tI18nComplete.raw('text1707565fd3f0')
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
