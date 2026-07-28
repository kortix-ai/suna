/**
 * The agents every Kortix project ships with.
 *
 * Both entries are real files in the starter template — an agent IS a markdown
 * file in your repo, so the honest way to show what one is, is to show the two
 * that every project is created with. `description` and `mode` are the
 * frontmatter of `packages/starter/templates/base/.kortix/opencode/agents/<name>.md`
 * verbatim; `isDefault` is `default_agent` from that template's kortix.yaml.
 * demo-content.test.ts re-reads all three and fails if this drifts.
 *
 * There are only two because there ARE only two. Padding the list with agents
 * a new project does not get would be a nicer demo and a false one.
 */

export interface DemoAgent {
  name: string;
  /** Repo-relative path of the file this agent is. */
  path: string;
  description: string;
  /** OpenCode agent mode — `primary` runs a session, `subagent` is delegated to. */
  mode: string;
  /** The agent a session boots when it names none (`default_agent` in kortix.yaml). */
  isDefault?: boolean;
}

/** Path of the starter template these are read from, relative to the repo root. */
export const DEMO_AGENTS_SOURCE = 'packages/starter/templates/base/.kortix/opencode/agents';

export const DEMO_AGENTS: readonly DemoAgent[] = [
  {
    name: 'kortix',
    path: '.kortix/opencode/agents/kortix.md',
    description:
      'Generic Kortix general knowledge worker. Hands-on, full tool access, handles coding / research / content / ops / data tasks end-to-end in an isolated session sandbox. Edit this file to specialize for your project.',
    mode: 'primary',
    isDefault: true,
  },
  {
    name: 'memory-reflector',
    path: '.kortix/opencode/agents/memory-reflector.md',
    description:
      'Reflects on recent project activity and curates `.kortix/memory/` — the project brain. Runs on a cron (the `memory-reflector` trigger in kortix.yaml) and ends every run by opening a single change request titled `memory: …`. Edit the rubric section of the `kortix-memory` skill to change what gets remembered.',
    mode: 'primary',
  },
];
