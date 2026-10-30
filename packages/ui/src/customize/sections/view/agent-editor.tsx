'use client';

import { useLocalizedUiCatalog } from '../../../i18n/ui-catalog/use-localized-ui-catalog';
import { useTranslations as useI18nTranslations } from '../../../i18n';
/**
 * The agent editor — every field of one `agents.<name>` block in a
 * kortix_version 2 or 3 manifest (agent-first spec §2.2), as three reusable parts
 * and no shell of its own.
 *
 * The shell is `/projects/[id]/agent/[name]`
 * (`capabilities/agents/agent-page.tsx`): a routed page, two columns, the
 * instructions on the left and everything else on the right. It used to be a
 * pane swapped into the agent detail MODAL, one level under the Agents grid.
 * Customize is agent-centric now (Marko, 2026-09-01) — the agent is the object
 * a person is granted, so its editor is the core screen of Customize and gets
 * a URL, not a modal — and this module was split so the page can lay the
 * fields out its own way:
 *
 *  - `useAgentDraft` owns the draft, the baseline, the two writers (`set` for
 *    the Kortix block, `setOc` for the nested `behavior` block) and the dirty
 *    check. Pure state; no shell.
 *  - `useAgentEditorOptions` loads the three option lists the sections need
 *    (secrets, connectors, sandbox templates).
 *  - `AgentConfigSections` composes the right-hand column: Model, Access,
 *    Workspace, Tools, Basics — every section except the two the page
 *    promotes into its own header and left column (description, prompt).
 *
 * Saves round-trip the whole block to kortix.yaml via the agent-config route,
 * validated server-side against the manifest-schema validator before commit.
 *
 * ── How the sections are organised, and why ────────────────────────────────
 * The editor used to open with two headings, "Kortix" and "OpenCode", each
 * with an icon and a sentence naming the file it wrote to. That is a storage
 * taxonomy: to find "model" you first had to know that models are an OpenCode
 * concern. The sections are the questions you actually ask about an agent —
 * Model, Access, Workspace, Tools, Basics — and every field still writes to
 * exactly the same place it always did. `set` writes the Kortix block, `setOc`
 * writes the nested `behavior` block; that split is a fact about the code, not a
 * heading in the UI.
 *
 * Field blocks live in agent-editor-basics-fields.tsx (Basics + Model),
 * agent-editor-access-fields.tsx (Access + Workspace) and permission-editor.tsx
 * (Tools). Layout primitives are in agent-editor-primitives.tsx, the
 * all/pick/none grant control in grant-mode-field.tsx.
 */

import { Badge } from '../../../primitives/badge';
import { parseManifestText } from '@kortix/manifest-schema';
import type { ProjectConfigSummary, SandboxTemplate } from '@kortix/sdk';
import {
  type AgentConfigBlock,
  listConnectors,
  listProjectSandboxTemplates,
  listProjectSecrets,
  type RuntimeAgentConfig,
} from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';
import {
  ConnectorsSection,
  ProjectActionsSection,
  RegistryGrantSection,
  SecretsSection,
  SkillsSection,
  WorkspaceSection,
} from './agent-editor-access-fields';
import { BasicsSection, ModelSection } from './agent-editor-basics-fields';
import { EditorSectionStyleProvider } from './agent-editor-primitives';
import type { GrantOption } from './grant-mode-field';
import { ToolsSection } from './permission-editor';

export {
  AGENT_MODE_HELP,
  AGENT_MODE_LABEL,
  AGENT_MODES,
  KORTIX_PERMISSIONS_CATALOG,
  PERMISSION_ACTION_LABEL,
  PERMISSION_ACTION_ONLY_GROUP_LABEL,
  PERMISSION_ACTION_ONLY_KEYS,
  PERMISSION_ACTIONS,
  PERMISSION_KEY_HELP,
  PERMISSION_KEY_LABEL,
  PERMISSION_RULE_GROUPS,
  PERMISSION_RULE_KEYS,
  THEME_COLOR_SWATCH,
  THEME_COLORS,
} from './agent-editor-catalog';

/**
 * Order-independent serialization, for the dirty check.
 *
 * `set`/`setOc` clear a field with `delete`, which drops the key and re-adds it
 * at the END of the object when the field is set again. Plain
 * `JSON.stringify(draft) !== JSON.stringify(baseline)` therefore reported
 * "Unsaved changes" — and enabled Save — for a field the user had cleared and
 * then typed back exactly as it was. Sorting keys at every level takes
 * insertion order out of the comparison.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(',')}}`;
}

export type SetKortix = <K extends keyof AgentConfigBlock>(
  key: K,
  value: AgentConfigBlock[K],
) => void;
export type SetRuntime = <K extends keyof RuntimeAgentConfig>(
  key: K,
  value: RuntimeAgentConfig[K],
) => void;

export interface AgentDraft {
  draft: AgentConfigBlock;
  /** The runtime block, never undefined — sections read `oc.model` etc. */
  oc: RuntimeAgentConfig;
  set: SetKortix;
  setOc: SetRuntime;
  isDirty: boolean;
  /** Throw the draft away and return to the baseline. */
  discard: () => void;
  /** A save landed: the server's block is the new baseline AND the new draft. */
  commit: (saved: AgentConfigBlock) => void;
}

/**
 * A served block with its behavior under `behavior` only. The API answers the
 * pre-W4 `opencode` alias beside it; a draft that kept both would send two
 * copies of every edit.
 */
export function behaviorBlock(block: AgentConfigBlock): AgentConfigBlock {
  const { opencode, ...rest } = block;
  const behavior = block.behavior ?? opencode;
  return behavior ? { ...rest, behavior } : rest;
}

/**
 * The draft of one agent block. `initial` is read once — the caller keys the
 * component on the agent name so switching agents remounts rather than leaks.
 */
export function useAgentDraft(initial: AgentConfigBlock): AgentDraft {
  const [draft, setDraft] = useState<AgentConfigBlock>(() => behaviorBlock(initial));
  const [baseline, setBaseline] = useState<AgentConfigBlock>(() => behaviorBlock(initial));
  const isDirty = useMemo(
    () => stableStringify(draft) !== stableStringify(baseline),
    [draft, baseline],
  );

  // No governance field is a plain string anymore (that was `description`/
  // `model`, both moved to the runtime block) — clearing is undefined-only.
  const set = useCallback<SetKortix>((key, value) => {
    setDraft((d) => {
      const next = { ...d };
      if (value === undefined) delete next[key];
      else next[key] = value;
      return next;
    });
  }, []);

  // Behavior fields live nested under `draft.behavior` — same clear-on-empty
  // semantics as `set`, folded into the sub-object.
  const setOc = useCallback<SetRuntime>((key, value) => {
    setDraft((d) => {
      const oc: RuntimeAgentConfig = { ...(d.behavior ?? {}) };
      if (value === undefined || value === '') delete oc[key];
      else oc[key] = value;
      const next = { ...d };
      if (Object.keys(oc).length > 0) next.behavior = oc;
      else delete next.behavior;
      return next;
    });
  }, []);

  const discard = useCallback(() => setDraft(baseline), [baseline]);
  const commit = useCallback((saved: AgentConfigBlock) => {
    const block = behaviorBlock(saved);
    setBaseline(block);
    setDraft(block);
  }, []);

  return { draft, oc: draft.behavior ?? {}, set, setOc, isDirty, discard, commit };
}

export interface AgentEditorOptions {
  secretOptions: GrantOption[];
  connectorOptions: GrantOption[];
  sandboxTemplates: SandboxTemplate[];
  defaultSandboxSlug: string | null;
}

const CONNECTOR_STATUS_BADGE: Record<string, { label: string; variant: 'destructive' | 'muted' }> =
  {
    needs_auth: { label: 'Needs auth', variant: 'destructive' },
    error: { label: 'Error', variant: 'destructive' },
    disabled: { label: 'Disabled', variant: 'muted' },
  };

/**
 * The option lists behind the Access and Workspace pages. A stale sandbox pin
 * (a slug the project no longer declares) is the Workspace page's concern —
 * it shows the raw slug rather than snapping to "Project default".
 */
const EMPTY_TEMPLATES: SandboxTemplate[] = [];

/**
 * The three reads behind {@link useAgentEditorOptions}, as query options. The
 * agent page starts them next to the agent-config read, so the editor mounts
 * onto a warm cache instead of opening a third round of requests. One
 * definition keeps both callers on the same keys: a second key would be a
 * second fetch.
 */
export function agentEditorOptionQueries(projectId: string) {
  return {
    secrets: {
      queryKey: qk.project.secrets(projectId),
      queryFn: () => listProjectSecrets(projectId),
      ...contract('config'),
    },
    connectors: {
      queryKey: qk.project.connectors(projectId),
      queryFn: () => listConnectors(projectId, { includeSchemas: false }),
      ...contract('config'),
    },
    sandboxes: {
      queryKey: qk.project.sandboxTemplates(projectId),
      queryFn: () => listProjectSandboxTemplates(projectId),
      ...contract('config'),
    },
  };
}

export function useAgentEditorOptions(projectId: string): AgentEditorOptions {
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  const connectorStatusBadge = useLocalizedUiCatalog(CONNECTOR_STATUS_BADGE);
  const queries = agentEditorOptionQueries(projectId);
  const secretsQuery = useQuery(queries.secrets);
  const connectorsQuery = useQuery(queries.connectors);
  const sandboxesQuery = useQuery(queries.sandboxes);
  // One row per identifier: a secret with a shared value AND a personal
  // override lists twice in the API, once per layer.
  const secretOptions = useMemo<GrantOption[]>(() => {
    const seen = new Map<string, GrantOption>();
    for (const s of secretsQuery.data?.items ?? []) {
      if (seen.has(s.identifier)) continue;
      seen.set(s.identifier, {
        id: s.identifier,
        label: s.identifier,
        description: s.purpose || (s.name !== s.identifier ? `Env var ${s.name}` : undefined),
        trailing: s.system ? (
          <Badge variant="muted" size="xs">
            {tI18nComplete.raw('text6725e7bbcd28')}
          </Badge>
        ) : undefined,
      });
    }
    return [...seen.values()].sort((a, b) => a.id.localeCompare(b.id));
  }, [secretsQuery.data, tI18nComplete]);
  const connectorOptions = useMemo<GrantOption[]>(
    () =>
      (connectorsQuery.data?.connectors ?? [])
        .map((c) => {
          const status = connectorStatusBadge[c.status];
          return {
            id: c.slug,
            label: c.name || c.slug,
            description: c.slug,
            trailing: status ? (
              <Badge variant={status.variant} size="xs">
                {status.label}
              </Badge>
            ) : undefined,
          };
        })
        .sort((a, b) => a.label.localeCompare(b.label)),
    [connectorsQuery.data, connectorStatusBadge],
  );
  const sandboxTemplates = sandboxesQuery.data?.items ?? EMPTY_TEMPLATES;
  const defaultSandboxSlug = sandboxesQuery.data?.default_slug ?? null;

  return { secretOptions, connectorOptions, sandboxTemplates, defaultSandboxSlug };
}

/**
 * The right-hand column of the agent page: how it thinks, what it may reach,
 * where it runs, which tools it may call, and the switches that say whether
 * it can run at all. Description and prompt are NOT here — the page gives
 * those the header and the whole left column, so the two sections that carry
 * them are told to leave them out.
 *
 * Order is the order you configure an agent in once its instructions exist:
 * Model first (the one thing every agent needs), then the grants, then the
 * environment, then the tool rules most agents never touch, then the
 * housekeeping switches. `children` slots page-owned sections (triggers,
 * people) into the same stack so the column reads as one list.
 */
/** The rail's group headings, in order. */
export const AGENT_CONFIG_SECTION_GROUPS = ['General', 'Access', 'Runtime'] as const;
export type AgentConfigSectionGroup = (typeof AGENT_CONFIG_SECTION_GROUPS)[number];

/**
 * The page's topics, in rail order, each under a group heading.
 *
 * General is the agent itself and who runs it: overview, identity, people,
 * triggers. Access is one topic per grant set — skills, connectors, secrets,
 * Apps, project actions — each its own page (Marko, 2026-09-03: "split up
 * ACCESS … into its own standalone menu items on the left & we can have nicer
 * UX/UI for each"). Runtime is what a session runs on: model, tools,
 * workspace.
 *
 * `apps` is listed here unconditionally: Apps is generally available, so every
 * project gets the grant page.
 */
export const AGENT_CONFIG_SECTIONS = [
  { key: 'overview', label: 'Overview', group: 'General' },
  { key: 'basics', label: 'Basics', group: 'General' },
  { key: 'people', label: 'People', group: 'General' },
  { key: 'triggers', label: 'Triggers', group: 'General' },
  { key: 'skills', label: 'Skills', group: 'Access' },
  { key: 'subagents', label: 'Subagents', group: 'Access' },
  { key: 'commands', label: 'Commands', group: 'Access' },
  { key: 'extensions', label: 'Extensions', group: 'Access' },
  { key: 'connectors', label: 'Connectors', group: 'Access' },
  { key: 'secrets', label: 'Secrets', group: 'Access' },
  { key: 'apps', label: 'Apps', group: 'Access' },
  { key: 'drives', label: 'Drives', group: 'Access' },
  { key: 'actions', label: 'Kortix permissions', group: 'Access' },
  { key: 'model', label: 'Model', group: 'Runtime' },
  { key: 'tools', label: 'Tools', group: 'Runtime' },
  { key: 'workspace', label: 'Workspace', group: 'Runtime' },
] as const satisfies readonly { key: string; label: string; group: AgentConfigSectionGroup }[];

export function useLocalizedAgentConfigCatalog() {
  return useLocalizedUiCatalog({
    groups: AGENT_CONFIG_SECTION_GROUPS,
    sections: AGENT_CONFIG_SECTIONS,
  });
}

export type AgentConfigSectionKey = (typeof AGENT_CONFIG_SECTIONS)[number]['key'];

/** The grants only a kortix_version 3 manifest has: each names registered entries. */
export const REGISTRY_GRANT_SECTIONS = ['subagents', 'commands', 'extensions'] as const;
export type RegistryGrant = (typeof REGISTRY_GRANT_SECTIONS)[number];

/** The editor's topics for a manifest version. The registry grants exist from v3 on. */
export function agentConfigSectionKeys(schemaVersion: number): AgentConfigSectionKey[] {
  return AGENT_CONFIG_SECTIONS.map((s) => s.key).filter(
    (key) => schemaVersion >= 3 || !(REGISTRY_GRANT_SECTIONS as readonly string[]).includes(key),
  );
}

/** The names of one manifest registry (`commands:` or `extensions:`), with descriptions. */
function registryEntries(manifest: Record<string, unknown>, key: 'commands' | 'extensions'): GrantOption[] {
  const registry = manifest[key];
  if (!registry || typeof registry !== 'object' || Array.isArray(registry)) return [];
  return Object.entries(registry as Record<string, unknown>)
    .map(([name, entry]) => {
      const description = (entry as { description?: unknown } | null)?.description;
      return { id: name, label: name, description: typeof description === 'string' ? description : undefined };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * The pick lists behind the v3 grant pages. Subagents are the declared,
 * enabled agents with `mode` `subagent` or `all`, never the agent itself.
 * Commands and extensions are the root manifest's registries.
 * ponytail: names registered in an `imports:` file are not listed; a picked
 * one still shows as its own row. Read the merged registries from the API when
 * project detail serves them.
 */
export function registryGrantOptions(
  config: Pick<ProjectConfigSummary, 'manifest_raw'> & {
    agents: Pick<ProjectConfigSummary['agents'][number], 'name' | 'mode' | 'description' | 'enabled'>[];
  },
  agentName: string,
): Record<RegistryGrant, GrantOption[]> {
  let manifest: Record<string, unknown> = {};
  try {
    manifest = config.manifest_raw ? parseManifestText(config.manifest_raw, 'yaml') : {};
  } catch {
    // A manifest that does not parse lists nothing; the save path reports the error.
  }
  const subagents = config.agents
    .filter((a) => a.name !== agentName && a.enabled !== false && (a.mode === 'subagent' || a.mode === 'all'))
    .map((a) => ({ id: a.name, label: a.name, description: a.description ?? undefined }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return {
    subagents,
    commands: registryEntries(manifest, 'commands'),
    extensions: registryEntries(manifest, 'extensions'),
  };
}

/** The tab the pane opens on, and the one an unknown `?section=` falls back to. */
export const DEFAULT_AGENT_CONFIG_SECTION: AgentConfigSectionKey = 'overview';

export function isAgentConfigSectionKey(value: string | null): value is AgentConfigSectionKey {
  return AGENT_CONFIG_SECTIONS.some((s) => s.key === value);
}

/**
 * One tab of the configuration pane. The draft is shared across tabs — a
 * switch never drops an edit — and the save bar below the pane is global, so
 * a tab is a view, not a form of its own.
 *
 * People and Access are two tabs (Marko, 2026-09-03: "split the member
 * grants and the access to what the agent has"): who may use the agent, and
 * what the agent — and therefore they — may reach.
 */
export function AgentConfigSections({
  section,
  editor,
  options,
  skillsOptions,
  registryOptions,
  overview,
  triggers,
  people,
  skills,
  connectors,
  secrets,
  apps,
  drives,
  authority,
}: {
  section: AgentConfigSectionKey;
  editor: AgentDraft;
  options: AgentEditorOptions;
  skillsOptions: GrantOption[];
  /** The v3 grant pick lists (`registryGrantOptions`). */
  registryOptions?: Record<RegistryGrant, GrantOption[]>;
  /** Description + instructions — a page-owned section, the Overview tab. */
  overview?: React.ReactNode;
  /** The agent's triggers — a page-owned section, the Triggers tab. */
  triggers?: React.ReactNode;
  /** Who may use the agent — a page-owned section, the People tab. */
  people?: React.ReactNode;
  /** The catalog-backed grant pages (`agent-grant-pages.tsx`) — the same
   *  cards and modals as the project-wide tabs. When a host passes them the
   *  plain checklist sections below are the fallback only. */
  skills?: React.ReactNode;
  connectors?: React.ReactNode;
  secrets?: React.ReactNode;
  /** Which Kortix Apps the agent may open. Page-owned only: the picker needs
   *  the project's App list, which no checklist fallback has. */
  apps?: React.ReactNode;
  /** Which shared drives the agent mounts. Page-owned, and only with Volumes on. */
  drives?: React.ReactNode;
  /** What the agent can do once its Kortix permissions meet its IAM ceiling —
   *  a page-owned card under the Kortix permissions checklist. */
  authority?: React.ReactNode;
}) {
  const { draft, oc, set, setOc } = editor;
  // Every pane opens with a `lead` section (the pane title) and stacks its
  // later sections under Settings subsection headings.
  const body = (() => {
    switch (section) {
      case 'overview':
        return <>{overview}</>;
      case 'people':
        return <>{people}</>;
      case 'skills':
        return skills ?? <SkillsSection draft={draft} set={set} options={skillsOptions} />;
      case 'subagents':
      case 'commands':
      case 'extensions':
        return (
          <RegistryGrantSection
            grant={section}
            draft={draft}
            set={set}
            options={registryOptions?.[section] ?? []}
          />
        );
      case 'connectors':
        return (
          connectors ?? (
            <ConnectorsSection draft={draft} set={set} options={options.connectorOptions} />
          )
        );
      case 'secrets':
        return (
          secrets ?? <SecretsSection draft={draft} set={set} options={options.secretOptions} />
        );
      case 'apps':
        return <>{apps}</>;
      case 'drives':
        return <>{drives}</>;
      case 'actions':
        return (
          <>
            <ProjectActionsSection draft={draft} set={set} />
            {authority}
          </>
        );
      case 'triggers':
        return <>{triggers}</>;
      case 'model':
        return <ModelSection oc={oc} setOc={setOc} showPrompt={false} />;
      case 'workspace':
        return (
          <WorkspaceSection
            draft={draft}
            set={set}
            sandboxTemplates={options.sandboxTemplates}
            defaultSandboxSlug={options.defaultSandboxSlug}
          />
        );
      case 'tools':
        return (
          <ToolsSection permission={oc.permission} onChange={(next) => setOc('permission', next)} />
        );
      case 'basics':
        return (
          <BasicsSection draft={draft} set={set} oc={oc} setOc={setOc} showDescription={false} />
        );
    }
  })();
  return (
    <EditorSectionStyleProvider value="panel">
      <div className="space-y-8">{body}</div>
    </EditorSectionStyleProvider>
  );
}

export { grantSummary } from './grant-mode-field';
