/**
 * Agent-led project config authoring (web parity:
 * components/projects/customize/use-configure-thread.ts).
 *
 * Project config (agents / skills / commands) lives in the repo and is
 * read-only from the UI — the only way to change it is through a session that
 * edits the files on a branch and opens a change request. "New" and "Edit"
 * therefore don't write files directly: they start a fresh session seeded with
 * one of these prompts; the session auto-sends it once the runtime is ready and
 * the agent takes it from there.
 */

export type ConfigureKind = 'agent' | 'skill' | 'command';

const NEW_PROMPTS: Record<ConfigureKind, string> = {
  agent:
    'I want to configure a new agent for this project. Ask me what it should ' +
    'specialize in and how it should behave, then create its config at ' +
    '`.kortix/opencode/agents/<name>.md` and open a change request so I can review and merge it.',
  skill:
    'I want to add a new skill to this project. Ask me what capability it ' +
    'should provide and when it should trigger, then scaffold ' +
    '`.kortix/opencode/skills/<name>/SKILL.md` and open a change request so I can review and merge it.',
  command:
    'I want to create a new slash command for this project. Ask me what it ' +
    'should do, then add it at `.kortix/opencode/commands/<name>.md` and open a ' +
    'change request so I can review and merge it.',
};

export function newConfigPrompt(kind: ConfigureKind): string {
  return NEW_PROMPTS[kind];
}

export function editConfigPrompt(kind: ConfigureKind, name: string, path: string): string {
  return (
    `I want to update the "${name}" ${kind} (its config lives at \`${path}\`). ` +
    `Ask me what I'd like to change, then make the edit and open a change request so I can review and merge it.`
  );
}
