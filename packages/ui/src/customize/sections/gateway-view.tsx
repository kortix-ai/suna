'use client';

import { useLocalizedUiCatalog } from '../../i18n/ui-catalog/use-localized-ui-catalog';
import { useTranslations } from '../../i18n';
/**
 * Models — the whole `/projects/[id]/models` page: the shared capability
 * shell, one tab strip, and whichever section that strip has selected.
 *
 * ## It is the same page as Connectors, Agents and Skills, or it is wrong
 *
 * This screen used to build a SECOND shell inside the first one: a full-height
 * `Tabs` root, its own bordered tab row with its own horizontal padding, an
 * `underline` tab list, and six `TabsContent` panels that each opened their own
 * `overflow-y-auto`. Sat inside `CapabilityPageShell`, that read as a different
 * product from the five sibling tabs on the Customize bar — a rule under the
 * active label where every sibling draws a filled pill, content indented 20px
 * further than the heading above it, and up to three nested scrollers.
 *
 * There is one shell now. The tab strip is the shell's `filters` slot and uses
 * the DEFAULT `Tabs`/`TabsList`/`TabsTrigger` — no `type`, no `size`, no
 * classes — which is character-for-character what `connectors-page.tsx` passes.
 * The project-default model picker is the shell's `action` slot, beside the
 * heading, where every sibling page puts its one page-level control. The active
 * section is plain local state and renders as the shell's `children`, so the
 * shell's scroll container is the page's only one.
 *
 * ## Seven tabs
 *
 * Order follows the work: bring a key in, choose models, add your own provider,
 * hand a key out, shape the routing, then watch what it costs and what it did.
 *
 *  - **Providers** (was "API keys") is now ONLY the provider list. The gateway
 *    key and its reference moved out — see `gateway-access-tab.tsx` for why the
 *    split is by direction.
 *  - **Gateway** is that key plus the endpoints for calling it. Both legacy
 *    deep-links that used to land on `providers` (`llm-keys`, `llm-api`) land
 *    here, because this is where their content is.
 *  - **Playground is gone.** A prompt box that fanned one message across
 *    models. Every project already has a real session for that, one click away,
 *    with the full runtime behind it. Deleted, not hidden. The API route it
 *    called (`POST /gateway/playground`) still exists and is untouched.
 *  - **Budgets folded into Costs.** The cap belongs under the number it caps —
 *    see `gateway-budgets.tsx`.
 *
 * The active tab is LOCAL state, so switching tabs never touches the main
 * Customize rail. Deep-links / `openCustomize('llm-providers')` set the hosting
 * panel's section, read here via `useSettingsNav()` (once, and followed on
 * change) to pick the initial tab.
 *
 * This view reads `useSettingsNav()`, never a store directly, so it mounts
 * under either the legacy Customize panel or the new Settings panel — see
 * `packages/ui/src/internal/layout/settings-nav-context.tsx`.
 *
 * ## This module is also the dialog
 *
 * `ProjectProviderModal` — the quick version the session model picker and the
 * Secrets tab open — renders THESE components, not copies of them. It used to
 * be a second implementation with its own tab root, its own underline strip at
 * `text-xs`, its own labels ("API keys" for what this page calls "Providers"),
 * no project-default control, and a scroll body with no horizontal padding, so
 * the model rows ran into the modal's clipped edge. Four exports ended that:
 *
 *   - `LlmTabStrip` — takes an optional `tabs` SUBSET (`QUICK_LLM_TABS`), so
 *     the dialog draws three of the same pills, not three different ones.
 *   - `ProjectDefaultPicker` — the one page-level control, both places.
 *   - `LlmSections` — the section bodies, chosen by the host's `tab`.
 *   - `MODELS_PAGE_TITLE` / `MODELS_PAGE_DESCRIPTION` — the same two lines.
 *
 * None of them carries horizontal padding: the host column supplies it
 * (`CapabilityPageShell` here, `px-5` in the dialog). Adding one back here
 * double-indents the page.
 */

import { type ReactNode, useEffect, useMemo, useState } from 'react';

import { Tabs, TabsList, TabsTrigger } from '../../primitives/tabs';
import { errorToast } from '../../primitives/toast';
import { SplitSheet, SplitSheetContent, SplitSheetMain } from '../../primitives/split-sheet';
import { ProviderAccordion } from '../providers/provider-accordion';
import { ProviderConnect } from '../providers/provider-connect';
import { ProviderSheet } from '../providers/provider-sheet';
import {
  ModelsPageSheetContext,
  type ModelsPageSheetHost,
} from './models-page-sheet';
import { cn } from '../../internal/lib/utils';
import { ModelSelector } from '../../session/models/model-selector';
import { CapabilityPageShell } from '../shared/capability-page-shell';
import { GatewayAccessTab } from './gateway-access-tab';
import { CustomProviderPanel } from './llm-provider/custom-provider-panel';
import { ModelsTab } from './llm-provider/models-tab';
import { GatewayLogs } from './view/gateway/gateway-logs';
import { GatewayOverview } from './view/gateway/gateway-overview';
import { GatewayRouting } from './view/gateway/gateway-routing';
import { useSettingsNav } from '../../internal/layout/settings-nav-context';
import { PROJECT_ACTIONS } from '../../internal/lib/project-actions';
import { useProjectCan } from '../../internal/lib/use-project-can';
import { gatewayRoutingPolicyKey, resolveModelDefault, useModelDefaults, useProjectModels } from '@kortix/sdk/react';
import { useIsMutating } from '@tanstack/react-query';

export const MODELS_PAGE_TITLE = 'Models';
export const MODELS_PAGE_DESCRIPTION = 'Choose the providers and models this project can use.';

export type LlmTab =
  'providers' | 'models' | 'custom' | 'gateway' | 'routing' | 'overview' | 'logs';

export interface LlmTabEntry {
  id: LlmTab;
  label: string;
}

export const LLM_TABS: LlmTabEntry[] = [
  // The keys you bring IN. Only the provider list — it was called "API keys"
  // and also carried the gateway key and its reference, which point the other
  // way; see `gateway-access-tab.tsx`.
  { id: 'providers', label: 'Providers' },
  { id: 'models', label: 'Models' },
  // The custom-provider form used to be section 4 of the Providers tab. It
  // moved to its own tab so the screen everyone uses to paste a key stops
  // ending in a form almost nobody fills — see `custom-provider-panel.tsx`.
  { id: 'custom', label: 'Custom' },
  // The key you hand OUT, and the endpoints it opens. Two tabs once, four
  // apart, one of them sharing the other's label.
  { id: 'gateway', label: 'Gateway' },
  { id: 'routing', label: 'Routing' },
  // Stats AND the spend cap — the former Budgets tab is a section of this one.
  // Label is "Costs" — the id stays `overview` so the `llm-overview` /
  // `llm-budgets` legacy deep-link re-points (settings-tabs.ts) and this
  // file's own render switch keep working unchanged.
  { id: 'overview', label: 'Costs' },
  { id: 'logs', label: 'Logs' },
];

/**
 * The three tabs the QUICK version carries — `ProjectProviderModal`, the
 * dialog the session model picker and the Secrets tab open.
 *
 * It is a slice of `LLM_TABS`, not a second list: same ids, same labels, same
 * order, same pills, and it renders through the same `LlmTabStrip` and the
 * same `LlmSections`. What the dialog drops is the four tabs that are project
 * administration rather than "let me use a model right now" — Gateway (the key
 * you hand out), Routing, Costs and Logs. Those live on the full page, which
 * has the width and the height for a log table.
 */
export type QuickLlmTab = 'providers' | 'models' | 'custom';

export const QUICK_LLM_TABS: LlmTabEntry[] = LLM_TABS.filter((t) =>
  (['providers', 'models', 'custom'] as string[]).includes(t.id),
);

/** True when `tab` is one of the quick version's three. */
export function isQuickLlmTab(tab: string): tab is QuickLlmTab {
  return QUICK_LLM_TABS.some((t) => t.id === tab);
}

/**
 * The tabs a NATIVE project (llm_gateway flag off) gets — key intake only.
 *
 * Off-gateway there is no managed catalog, no model-defaults chain, no
 * gateway key/routing/costs/logs: OpenCode in the sandbox owns models, and
 * the provider keys entered here reach it as plain env vars. Same slice
 * discipline as `QUICK_LLM_TABS`: a subset of `LLM_TABS`, never a second
 * list.
 */
export type NativeLlmTab = 'providers' | 'custom';

export const NATIVE_LLM_TABS: LlmTabEntry[] = LLM_TABS.filter((t) =>
  (['providers', 'custom'] as string[]).includes(t.id),
);

/** True when `tab` exists for a native (gateway-off) project. */
export function isNativeLlmTab(tab: string): tab is NativeLlmTab {
  return NATIVE_LLM_TABS.some((t) => t.id === tab);
}

/**
 * The legacy Customize overlay's `llm-*` `CustomizeSection` ids. The new
 * Settings overlay's `SettingsTab` union has no equivalent — every one of
 * these collapses into the single `models` tab at the redirect
 * (`settings-tabs.ts`'s `RENAMED_TABS`), so `activeTab` is never one of them
 * while mounted there; this map only fires while mounted under the legacy
 * panel (deleted once the cutover is complete) or for a raw deep-link value
 * that slips through before a redirect resolves. Kept local (not imported
 * from the legacy Customize-sections module, which no longer exists) since nothing
 * else needs this exact 7-member set.
 */
type LegacyLlmSubTab =
  | 'llm-management'
  | 'llm-overview'
  | 'llm-providers'
  | 'llm-logs'
  | 'llm-budgets'
  | 'llm-keys'
  | 'llm-api';

const TAB_BY_SECTION: Partial<Record<LegacyLlmSubTab, LlmTab>> = {
  'llm-management': 'providers',
  'llm-providers': 'providers',
  'llm-overview': 'overview',
  'llm-logs': 'logs',
  // Budgets is a section of Costs now. `llm-keys` (create a gateway key) and
  // `llm-api` (call the gateway with it) point at the Gateway tab, which is
  // where that content lives — they pointed at `providers` only for as long as
  // it held all three key surfaces.
  'llm-budgets': 'overview',
  'llm-keys': 'gateway',
  'llm-api': 'gateway',
};

/**
 * The tab strip, pure — no hooks, so it renders under `renderToStaticMarkup`
 * with no provider tree, which is the repo's only render-assertion idiom.
 *
 * The props are `connectors-page.tsx`'s exactly: a controlled `Tabs`, a bare
 * `TabsList`, a `TabsTrigger` per entry. Nothing here may grow a `type`, a
 * `size` or a className — the whole point of this component is that Models and
 * Connectors draw the same control, and a prop added on one side is how they
 * stop.
 *
 * `tabs` is a SUBSET, never a different list: the modal passes
 * `QUICK_LLM_TABS` and gets the same pills, the same labels and the same order
 * as the page. It is the only knob, and it selects entries out of `LLM_TABS` —
 * it cannot introduce one.
 */
export function LlmTabStrip({
  value,
  onValueChange,
  tabs = LLM_TABS,
}: {
  value: string;
  onValueChange: (next: string) => void;
  tabs?: readonly LlmTabEntry[];
}) {
  const localizedTabs = useLocalizedUiCatalog(tabs);
  return (
    <Tabs value={value} onValueChange={onValueChange}>
      <TabsList>
        {localizedTabs.map((t) => (
          <TabsTrigger key={t.id} value={t.id}>
            {t.label}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}

/**
 * The project-default model picker — the ONE page-level control, rendered by
 * the page in `CapabilityPageShell`'s `action` slot and by the modal in the
 * same place beside its title.
 *
 * The project default is the single model authority for this project. Account
 * and platform defaults are display-only inheritance when no project value is
 * configured; choosing here always writes project scope.
 *
 * Callers gate it on write access — a role with the LLM section's READ leaf
 * (`project.read`) but not `project.write` sees the gateway read-only, and the
 * one mutating control in this bar is hidden rather than left to 403.
 */
export function ProjectDefaultPicker({ projectId }: { projectId: string }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const models = useProjectModels(projectId);
  const modelDefaults = useModelDefaults(projectId);
  const routingMutationCount = useIsMutating({ mutationKey: gatewayRoutingPolicyKey(projectId) });
  const effectiveDefault = resolveModelDefault(modelDefaults.data, undefined) ?? null;

  return (
    <div className="flex shrink-0 items-center" title={tI18nComplete.raw('texte8cb80e5c5cb')}>
      <ModelSelector
        triggerVariant="secondary"
        models={models}
        selectedModel={effectiveDefault}
        unsetLabel={tI18nComplete.raw('texte8cb80e5c5cb')}
        disabled={modelDefaults.isLoading || modelDefaults.isUpdating || routingMutationCount > 0}
        onSelect={(m) => {
          if (!m) return;
          void modelDefaults
            .setProjectDefault(m)
            .catch(() => errorToast(tI18nComplete.raw('text5ed9bd98de1b')));
        }}
      />
    </div>
  );
}

/**
 * The selected section — the page's body and the modal's, character for
 * character.
 *
 * One section at a time, by the caller's state — NOT seven `TabsContent`
 * panels. Radix keeps every panel in the tree and each one used to open its
 * own `overflow-y-auto`, which is how this page ended up with three nested
 * scroll containers under a shell that already had one.
 *
 * It renders NO padding of its own: the host column supplies it
 * (`CapabilityPageShell`'s `max-w-5xl px-4` on the page, the modal's `px-5`),
 * which is what makes the model list line up under the heading in both.
 */
export function LlmSections({
  projectId,
  tab,
  onTabChange,
  canWrite,
  enabled,
  selectedProviderId,
  onSelectProvider,
  providersVariant = 'split',
}: {
  projectId: string;
  tab: LlmTab;
  /** Sections that hand the reader on — the custom form's "Done", the gateway
   *  tab's "view models" — move the host's tab, so it has to come back up. */
  onTabChange: (next: LlmTab) => void;
  canWrite: boolean;
  /** Gates the provider list's fetch. False while the host is closed. */
  enabled: boolean;
  /** The provider open in the host's `SplitSheet` (`ProviderSheetSplit`). */
  selectedProviderId?: string | null;
  onSelectProvider: (providerId: string) => void;
  /** `split`: the page's list + SplitSheet. `accordion`: the quick dialog's
   *  rows that open in place (Paper PM01 + AK01) — no room for a second column. */
  providersVariant?: 'split' | 'accordion';
}) {
  const modelDefaults = useModelDefaults(projectId);

  return (
    <>
      {tab === 'providers' && providersVariant === 'accordion' && (
        <ProviderAccordion projectId={projectId} canWrite={canWrite} enabled={enabled} />
      )}
      {tab === 'providers' && providersVariant === 'split' && (
        /* JAY-510: this path mounts `ProviderConnect` DIRECTLY — no nested
           dialog, so connecting Anthropic here opens nothing on top of what
           you are already looking at. `p-0` because the host column already
           carries the padding. */
        <ProviderConnect
          projectId={projectId}
          canWrite={canWrite}
          enabled={enabled}
          selectedId={selectedProviderId}
          onSelect={onSelectProvider}
        />
      )}
      {/* The model-visibility list used to sit one level deeper, inside the
          provider modal's own "Models" tab. Flattened to a sibling here so it
          keeps a home now that `ProviderConnect` has no tabs of its own. */}
      {tab === 'models' && <ModelsTab projectId={projectId} canWrite={canWrite} />}
      {/* A saved custom provider gets a key like any other and a row on the
          provider list, so a "Done" that leaves you on the form you just
          submitted is not done. */}
      {tab === 'custom' && (
        <CustomProviderPanel
          projectId={projectId}
          canWrite={canWrite}
          onDone={() => onTabChange('providers')}
        />
      )}
      {tab === 'gateway' && (
        <GatewayAccessTab
          projectId={projectId}
          canWrite={canWrite}
          onViewModels={() => onTabChange('models')}
        />
      )}
      {tab === 'routing' && (
        <GatewayRouting
          projectId={projectId}
          canWrite={canWrite}
          projectDefaultPending={modelDefaults.isUpdating}
        />
      )}
      {/* Stats + the spend cap. `canWrite` reaches the budget controls that
          used to live one tab over. */}
      {tab === 'overview' && <GatewayOverview projectId={projectId} canWrite={canWrite} />}
      {tab === 'logs' && <GatewayLogs projectId={projectId} />}
    </>
  );
}

export function LlmManagementView({
  projectId,
  llmGatewayEnabled = true,
}: {
  projectId: string;
  /**
   * The project's `llm_gateway` flag. Off ⇒ the page is the NATIVE key-intake
   * surface: Providers + Custom only, no project-default picker, no gateway
   * administration tabs (their routes 404 `llm_gateway_disabled`).
   */
  llmGatewayEnabled?: boolean;
}) {
  const { isOpen: open, activeTab: section } = useSettingsNav();
  const [tab, setTab] = useState<LlmTab>(
    () => TAB_BY_SECTION[section as LegacyLlmSubTab] ?? 'providers',
  );
  const effectiveTab: LlmTab = llmGatewayEnabled ? tab : isNativeLlmTab(tab) ? tab : 'providers';

  // A role with the LLM section's READ leaf (project.read) but not
  // project.write sees the gateway read-only: logs/overview/spend stay
  // visible, but the project-default model picker is hidden so a read-only
  // user cannot trigger a forbidden write.
  const canWrite =
    useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_MODEL_WRITE).allowed === true;

  // Follow an external deep-link (e.g. openCustomize('llm-providers')) to its
  // tab. Plain in-view tab clicks stay local and never move the main rail.
  useEffect(() => {
    const next = TAB_BY_SECTION[section as LegacyLlmSubTab];
    if (next) setTab(next);
  }, [section]);

  const [providerId, setProviderId] = useState<string | null>(null);

  return (
    <ProviderSheetSplit
      projectId={projectId}
      providerId={effectiveTab === 'providers' ? providerId : null}
      onProviderChange={setProviderId}
      canWrite={canWrite}
    >
    <CapabilityPageShell
      title={MODELS_PAGE_TITLE}
      description={MODELS_PAGE_DESCRIPTION}
      filters={
        /* The tab strip on the left, the project default on the right of the
           same row. Native mode has no model-defaults chain, so no picker. */
        <>
          <LlmTabStrip
            value={effectiveTab}
            tabs={llmGatewayEnabled ? undefined : NATIVE_LLM_TABS}
            onValueChange={(v) => setTab(v as LlmTab)}
          />
          {canWrite && llmGatewayEnabled ? <ProjectDefaultPicker projectId={projectId} /> : null}
        </>
      }
    >
      <LlmSections
        projectId={projectId}
        tab={effectiveTab}
        onTabChange={setTab}
        canWrite={canWrite}
        enabled={open}
        selectedProviderId={providerId}
        onSelectProvider={setProviderId}
      />
    </CapabilityPageShell>
    </ProviderSheetSplit>
  );
}

/**
 * The provider list beside the provider it opened — the page and the quick
 * dialog both host it. In-flow `SplitSheet`, not an overlay: the list narrows
 * and stays usable, and below 48rem of width the sheet covers it instead.
 */
export function ProviderSheetSplit({
  projectId,
  providerId,
  onProviderChange,
  canWrite,
  className,
  contentClassName,
  children,
}: {
  projectId: string;
  providerId: string | null;
  onProviderChange: (providerId: string | null) => void;
  canWrite: boolean;
  className?: string;
  /** The sheet column's surface — the quick dialog matches its own background. */
  contentClassName?: string;
  children: ReactNode;
}) {
  // Another tab's claim on the column (`useModelsPageSheet`): its close
  // handler, and the element its portal renders into.
  const [sectionClose, setSectionClose] = useState<(() => void) | null>(null);
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const host = useMemo<ModelsPageSheetHost>(
    () => ({ target, claim: (onClose) => setSectionClose(() => onClose) }),
    [target],
  );
  return (
    <ModelsPageSheetContext.Provider value={host}>
      <SplitSheet
        open={!!providerId || !!sectionClose}
        onOpenChange={(open) => {
          if (open) return;
          if (providerId) onProviderChange(null);
          else sectionClose?.();
        }}
        size="lg"
        className={cn('flex-1', className)}
      >
        <SplitSheetMain>{children}</SplitSheetMain>
        <SplitSheetContent className={contentClassName}>
          {providerId ? (
            <ProviderSheet projectId={projectId} providerId={providerId} canWrite={canWrite} />
          ) : (
            <div ref={setTarget} className="contents" />
          )}
        </SplitSheetContent>
      </SplitSheet>
    </ModelsPageSheetContext.Provider>
  );
}
