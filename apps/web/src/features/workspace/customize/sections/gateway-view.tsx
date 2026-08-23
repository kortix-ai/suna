'use client';

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
 * `features/workspace/shared/settings-nav-context.tsx`.
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

import { useEffect, useState } from 'react';

import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { errorToast } from '@/components/ui/toast';
import { ProviderConnect } from '@/features/providers/provider-connect';
import { ModelSelector } from '@/features/session/model-selector';
import { CapabilityPageShell } from '@/features/workspace/capabilities/shared/capability-page-shell';
import { GatewayAccessTab } from '@/features/workspace/customize/sections/gateway-access-tab';
import { CustomProviderPanel } from '@/features/workspace/customize/sections/llm-provider/custom-provider-panel';
import { ModelsTab } from '@/features/workspace/customize/sections/llm-provider/models-tab';
import { GatewayLogs } from '@/features/workspace/customize/sections/view/gateway/gateway-logs';
import { GatewayOverview } from '@/features/workspace/customize/sections/view/gateway/gateway-overview';
import { GatewayRouting } from '@/features/workspace/customize/sections/view/gateway/gateway-routing';
import { useSettingsNav } from '@/features/workspace/shared/settings-nav-context';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';
import { gatewayRoutingPolicyKey, useModelDefaults, useProjectModels } from '@kortix/sdk/react';
import { useIsMutating } from '@tanstack/react-query';

export const MODELS_PAGE_TITLE = 'Models';
export const MODELS_PAGE_DESCRIPTION = 'Which providers and models this project can use.';

export type LlmTab =
  | 'providers'
  | 'models'
  | 'custom'
  | 'gateway'
  | 'routing'
  | 'overview'
  | 'logs';

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
  return (
    <Tabs value={value} onValueChange={onValueChange}>
      <TabsList>
        {tabs.map((t) => (
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
  const models = useProjectModels(projectId);
  const modelDefaults = useModelDefaults(projectId);
  const routingMutationCount = useIsMutating({ mutationKey: gatewayRoutingPolicyKey(projectId) });
  const effectiveDefault =
    modelDefaults.projectDefault ??
    modelDefaults.accountDefault ??
    (modelDefaults.freeTier ? undefined : modelDefaults.platformDefault) ??
    null;

  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <span className="text-muted-foreground hidden text-xs sm:inline">Project default</span>
      <ModelSelector
        models={models}
        selectedModel={effectiveDefault}
        unsetLabel="Project default"
        disabled={modelDefaults.isLoading || modelDefaults.isUpdating || routingMutationCount > 0}
        onSelect={(m) => {
          if (!m) return;
          void modelDefaults
            .setProjectDefault(m)
            .catch(() => errorToast('Could not update the project default'));
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
}: {
  projectId: string;
  tab: LlmTab;
  /** Sections that hand the reader on — the custom form's "Done", the gateway
   *  tab's "view models" — move the host's tab, so it has to come back up. */
  onTabChange: (next: LlmTab) => void;
  canWrite: boolean;
  /** Gates the provider list's fetch. False while the host is closed. */
  enabled: boolean;
}) {
  const modelDefaults = useModelDefaults(projectId);

  return (
    <>
      {tab === 'providers' && (
        /* JAY-510: this path mounts `ProviderConnect` DIRECTLY — no nested
           dialog, so connecting Anthropic here opens nothing on top of what
           you are already looking at. `p-0` because the host column already
           carries the padding. */
        <ProviderConnect
          projectId={projectId}
          canWrite={canWrite}
          enabled={enabled}
          className="gap-4 p-0"
        />
      )}
      {/* The model-visibility list used to sit one level deeper, inside the
          provider modal's own "Models" tab. Flattened to a sibling here so it
          keeps a home now that `ProviderConnect` has no tabs of its own. */}
      {tab === 'models' && <ModelsTab projectId={projectId} />}
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

export function LlmManagementView({ projectId }: { projectId: string }) {
  const { isOpen: open, activeTab: section } = useSettingsNav();
  const [tab, setTab] = useState<LlmTab>(
    () => TAB_BY_SECTION[section as LegacyLlmSubTab] ?? 'providers',
  );

  // A role with the LLM section's READ leaf (project.read) but not
  // project.write sees the gateway read-only: logs/overview/spend stay
  // visible, but the project-default model picker is hidden so a read-only
  // user cannot trigger a forbidden write.
  const canWrite =
    useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_CUSTOMIZE_WRITE).allowed === true;

  // Follow an external deep-link (e.g. openCustomize('llm-providers')) to its
  // tab. Plain in-view tab clicks stay local and never move the main rail.
  useEffect(() => {
    const next = TAB_BY_SECTION[section as LegacyLlmSubTab];
    if (next) setTab(next);
  }, [section]);

  return (
    <CapabilityPageShell
      title={MODELS_PAGE_TITLE}
      description={MODELS_PAGE_DESCRIPTION}
      action={
        /* The page's one page-level control, in the slot every sibling page
           puts its one page-level control in. It is NOT in the `filters` row
           beside the tabs: a bordered dropdown opposite a filled pill strip
           reads as a second tab strip, and the row that has to look identical
           to Connectors / Agents / Skills is exactly that one. */
        canWrite ? <ProjectDefaultPicker projectId={projectId} /> : undefined
      }
      filters={<LlmTabStrip value={tab} onValueChange={(v) => setTab(v as LlmTab)} />}
    >
      <LlmSections
        projectId={projectId}
        tab={tab}
        onTabChange={setTab}
        canWrite={canWrite}
        enabled={open}
      />
    </CapabilityPageShell>
  );
}
