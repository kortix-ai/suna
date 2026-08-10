'use client';

/**
 * The Instructions tab — houses `commands-view.tsx`'s `CommandsView`.
 * `settings-panel.tsx:1122-1123` used to mount `CommandsView` directly at
 * `case 'instructions'`; this file gives it the same container/pure-view
 * shape every other migrated tab has (`sandbox-tab.tsx`, `experimental-tab.tsx`,
 * …) with no change in rendered behavior — see the two findings below for why
 * there is nothing else to build here.
 *
 * **Task 21 finding — no project-level instructions surface exists.** The
 * design doc (`docs/superpowers/specs/2026-08-09-settings-panel-design.md:299`)
 * describes this tab as "Instructions | agent instructions + `commands-view.tsx`
 * folded in" and (`:455-457`) "Agent instructions, with slash commands
 * (`commands-view.tsx`) as a section below them." No such project-level
 * instructions field, editor, or API response exists anywhere in the
 * codebase:
 *   - `ProjectConfigSummary` (`packages/sdk/src/core/rest/projects-client/
 *     projects.ts:88-119`) has `agents`, `skills`, `commands`, `env`,
 *     `manifest_raw`, `open_code_raw`, `default_agent` — no `instructions`
 *     field of any kind.
 *   - `grep -rniE "\binstructions\b" packages/sdk/src` (excluding tests)
 *     matches nothing.
 *   - The nearest thing is the PER-AGENT "System prompt" field
 *     (`agent-editor-basics-fields.tsx:324`, help text "Replaces the default
 *     instructions for this agent") — it belongs to one agent (`oc.prompt`
 *     on that agent's own OpenCode config), not the project. Writing a
 *     project-level editor against a field that does not exist would be a
 *     fabricated surface, not a real one — see this task's brief. So this
 *     tab renders commands only, same as before this task.
 *
 * **`CommandsView` stays mounted — this IS its only reachable surface.**
 * Before this task, `grep -rn "CommandsView" src` matched exactly three
 * lines: the import and mount site (formerly `settings-panel.tsx`, now
 * this file's `import` line and its use inside `InstructionsTab` below)
 * plus its own definition in `commands-view.tsx`. Its standalone page was
 * deleted in #6169 (see that file's own header comment), so losing this
 * mount would orphan the component entirely — it is kept, unchanged.
 *
 * **Redirect and palette entry — both already worked before this task.**
 *   - `/customize/commands`: `legacySectionRedirect`'s `RENAMED_TABS` already
 *     maps `commands: 'instructions'` (`settings-tabs.ts:125`), asserted by
 *     `settings-tabs.test.ts:47`
 *     (`legacySectionRedirect('p1', 'commands')` ->
 *     `/projects/p1/settings/instructions`). No change needed.
 *   - `proj-commands` (`menu-registry.ts:451-459`) already has
 *     `href: '/projects/{projectId}/settings/instructions'` — it does not
 *     route through `/customize/commands` at all. No change needed.
 *
 * **Why `CommandsView` is a slot, not rendered inline.** Same reasoning as
 * `sandbox-tab.tsx`'s `templatesSlot`: `CommandsView` -> `ConfigEntityView`
 * owns its own `useQuery`/`useMutation`/`useProjectCan` and cannot render
 * under `renderToStaticMarkup` with no `QueryClientProvider`.
 * `ConfigEntityView` already renders its own `SettingsSectionHeader`
 * (title="Commands") via `CustomizeSectionWrapper`
 * (`section-wrapper.tsx:113`), so `InstructionsTabView` intentionally adds
 * no second heading of its own — doing so would stack two headers over one
 * section, not meet the design bar.
 *
 * `InstructionsTab` is the container: it only exists once this tab is
 * active, which `SettingsTabPane` in `settings-panel.tsx` guarantees
 * (`if (!active) return null;`), so nothing here fetches on panel open.
 */

import type { ReactNode } from 'react';

import { CommandsView } from '@/features/workspace/customize/sections/view/commands-view';

export interface InstructionsTabViewProps {
  /** `CommandsView`, built by the container — see this file's header
   *  comment for why it's a slot. `undefined` (nothing rendered) lets this
   *  view render under `renderToStaticMarkup` with no providers. */
  commandsSlot?: ReactNode;
}

/** Presentational only — no hooks, no data fetching. Kept separate from
 *  `InstructionsTab` so this renders under `renderToStaticMarkup` — see
 *  `SandboxTabView` for the same split. */
export function InstructionsTabView({ commandsSlot }: InstructionsTabViewProps) {
  return <>{commandsSlot}</>;
}

/** Container: mounts `CommandsView` as the slot. Only ever mounted while
 *  this tab is active (`SettingsTabPane` returns `null` otherwise). */
export function InstructionsTab({ projectId }: { projectId: string }) {
  return <InstructionsTabView commandsSlot={<CommandsView projectId={projectId} />} />;
}
