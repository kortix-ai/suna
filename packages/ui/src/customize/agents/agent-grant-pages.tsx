import { uiRoutes } from '../../lib/routes';
import { useTranslations as useI18nTranslations } from '../../i18n';
/**
 * The agent editor's Apps grant, as a plain catalog — the fallback for a host
 * that does not hand `AgentPage` the full Apps screen (`renderApps`). The web
 * app always does: there the Apps section is `AppsView` in agent scope, the
 * same 2-variant pattern as Connectors, Skills, Secrets, Models and Triggers.
 *
 * Layout is the Settings page's: the pane title, one All · Pick · None row
 * (`grant-mode-field.tsx`), then the catalog as one bordered list.
 */

import { Badge } from '../../primitives/badge';
import { Button } from '../../primitives/button';
import { Checkbox } from '../../primitives/checkbox';
import { Skeleton } from '../../primitives/skeleton';
import { EmptyState } from '../../primitives/empty-state';
import { ErrorState } from '../../primitives/error-state';
import type { AgentDraft } from '../sections/view/agent-editor';
import { ManageButton } from '../sections/view/agent-editor-access-fields';
import { EditorList, EditorSection } from '../sections/view/agent-editor-primitives';
import { type GrantMode, GrantModeField } from '../sections/view/grant-mode-field';
import { cn } from '../../internal/lib/utils';
import type { AgentGrantSetV2 } from '@kortix/sdk';
import { useProjectApps } from '@kortix/sdk/react';
import type { ReactNode } from 'react';
import { appGrantRows } from './agent-apps-grant';

// ─── The shared catalog ──────────────────────────────────────────────────

interface GrantCatalogItem {
  id: string;
  /** A real logo only (a connector's app icon). A glyph that repeats on every
   *  row names nothing, so skills, secrets and Apps pass none. */
  leading?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  /** Exceptions only, as `Badge`s at the row's right edge: Needs setup, Not
   *  set. The normal state carries no mark. */
  status?: ReactNode;
  onOpen?: () => void;
}

/**
 * All · Pick · None over the project's catalog, as one bordered list. The
 * checkbox exists only in Pick mode, where it is the control; in All and
 * None the mode row above already answers for every row. A granted id the
 * catalog no longer has still renders, flagged, so a stale grant is visible
 * rather than silently dropped.
 */
function GrantCatalog({
  value,
  onChange,
  items,
  isLoading,
  isError,
  onRetry,
  empty,
}: {
  value: AgentGrantSetV2 | undefined;
  onChange: (v: AgentGrantSetV2) => void;
  items: GrantCatalogItem[];
  isLoading?: boolean;
  isError?: boolean;
  onRetry?: () => void;
  empty: ReactNode;
}) {
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  return (
    <GrantModeField
      value={value}
      onChange={onChange}
      alwaysRender
    >
      {({ selected, toggle, mode }) => {
        if (isLoading) {
          return (
            <EditorList>
              {[0, 1, 2].map((i) => (
                <li key={i} className="flex items-center gap-3 px-4 py-3">
                  <Skeleton className="h-4 w-40 rounded-sm" />
                </li>
              ))}
            </EditorList>
          );
        }
        if (isError) {
          return (
            <ErrorState
              size="sm"
              title={tI18nComplete.raw('text3f2d97c61a7e')}
              action={
                onRetry ? (
                  <Button variant="outline" size="sm" onClick={onRetry}>
                    {tI18nComplete.raw('text942087cc2d41')}
                  </Button>
                ) : undefined
              }
            />
          );
        }
        const known = new Set(items.map((i) => i.id));
        const orphans: GrantCatalogItem[] = [...selected]
          .filter((id) => !known.has(id))
          .map((id) => ({
            id,
            title: <span className="font-mono">{id}</span>,
            description: tI18nComplete.raw('textfecc36d012be'),
            status: (
              <Badge variant="destructive" size="xs">
                {tI18nComplete.raw('text6be36ca49ee8')}
              </Badge>
            ),
          }));
        if (items.length === 0 && orphans.length === 0) return <>{empty}</>;
        return (
          <EditorList>
            {[...items, ...orphans].map((item) => (
              <GrantRow
                key={item.id}
                item={item}
                mode={mode}
                checked={selected.has(item.id)}
                onToggle={() => toggle(item.id)}
                checkLabel={tI18nComplete('textd4170e74c3b0', { value0: item.id })}
              />
            ))}
          </EditorList>
        );
      }}
    </GrantModeField>
  );
}

/**
 * One catalog row. The checkbox and the body are two sibling controls, never
 * one nested in the other: the checkbox grants, the body opens the entity.
 */
function GrantRow({
  item,
  mode,
  checked,
  onToggle,
  checkLabel,
}: {
  item: GrantCatalogItem;
  mode: GrantMode;
  checked: boolean;
  onToggle: () => void;
  checkLabel: string;
}) {
  const body = (
    <>
      {item.leading}
      <span className="min-w-0 flex-1">
        <span className="text-foreground block truncate text-sm font-medium">{item.title}</span>
        {item.description ? (
          <span className="text-muted-foreground block truncate text-xs">{item.description}</span>
        ) : null}
      </span>
    </>
  );
  return (
    <li
      className={cn(
        'flex min-h-13 items-center gap-3 px-4 py-2 transition-colors duration-fast',
        item.onOpen && 'hover:bg-hover',
        mode === 'none' && 'opacity-60',
      )}
    >
      {mode === 'pick' ? (
        <Checkbox variant="black" checked={checked} onCheckedChange={onToggle} aria-label={checkLabel} />
      ) : null}
      {item.onOpen ? (
        <button
          type="button"
          onClick={item.onOpen}
          className="focus-visible:ring-ring/50 flex min-w-0 flex-1 items-center gap-3 rounded-sm text-left focus-visible:ring-2 focus-visible:outline-none"
        >
          {body}
        </button>
      ) : (
        <span className="flex min-w-0 flex-1 items-center gap-3">{body}</span>
      )}
      {item.status ? (
        <span className="flex shrink-0 items-center gap-2">
          {item.status}
        </span>
      ) : null}
    </li>
  );
}

// ─── Apps ────────────────────────────────────────────────────────────────

/**
 * Which Kortix Apps this agent may open — `agents.<name>.apps` in
 * kortix.yaml, the same All · Pick · None machine as Connectors and the same
 * cards.
 *
 * The grant decides admission for a `restricted` or `private` App only. A
 * `project` App admits any agent that holds `project.app.read`, a `public` App
 * admits everyone, and a `password` App admits no agent at all — so a row for
 * one of those is still grantable (its mode can change) but is flagged as not
 * currently load-bearing.
 *
 * Enforcement is the App gate (`agentAppAccessDecision`, apps/api/src/apps/
 * access.ts).
 */
export function AppsGrantPage({ projectId, editor }: { projectId: string; editor: AgentDraft }) {
  const t = useI18nTranslations('agentApps');
  const appsQuery = useProjectApps(projectId);
  const rows = appGrantRows(appsQuery.data);
  return (
    <EditorSection
      title={t('title')}
      description={t('description')}
      trailing={<ManageButton href={(id) => uiRoutes().apps(id)} />}
      lead
      bare
    >
      <div className="space-y-3" data-testid="agent-apps-grant">
        <GrantCatalog
          value={editor.draft.apps}
          onChange={(v) => editor.set('apps', v)}
          isLoading={appsQuery.isLoading}
          isError={appsQuery.isError}
          onRetry={() => void appsQuery.refetch()}
          items={rows.map((row) => ({
            id: row.id,
            title: <span className="font-mono">{row.id}</span>,
            description: row.name === row.id ? null : row.name,
            // The grant decides admission for a restricted or private App, the
            // normal case. Only an App that admits agents without it is flagged.
            status: row.needsGrant ? undefined : (
              <Badge variant="muted" size="xs">
                {t('openWithoutGrant')}
              </Badge>
            ),
          }))}
          empty={
            <EmptyState
              size="sm"
              title={t('emptyTitle')}
              description={t('emptyDescription')}
            />
          }
        />
      </div>
    </EditorSection>
  );
}
