/**
 * The seed prompts of a "configure" session: "New agent", "New skill", … start
 * a fresh session with one of these as its first message. The agent asks what
 * the user wants, edits the project config on a branch, and opens a change
 * request. Shared by apps/web (Customize, the capability pages) and
 * apps/mobile (the model sheet's Agent tab), so both send the same words.
 */

export const CONFIGURE_KINDS = ["agent", "skill", "command", "connector", "trigger", "secret"] as const;

export type ConfigureKind = (typeof CONFIGURE_KINDS)[number];

const NEW_PROMPTS: Record<ConfigureKind, string> = {
  agent:
    "I want to configure a new agent for this project. Ask me what it should " +
    "specialize in and how it should behave, then create its config at " +
    "`agents/<name>.md`, declare it in `kortix.yaml` under `agents:` with " +
    "`file: agents/<name>.md` and the access it needs, and open a change " +
    "request so I can review and merge it.",
  skill:
    "I want to add a new skill to this project. Ask me what capability it " +
    "should provide and when it should trigger, then scaffold " +
    "`skills/<name>/SKILL.md` and open a change request so I can review and merge it.",
  command:
    "I want to create a new slash command for this project. Ask me what it " +
    "should do, then add it at `harnesses/opencode/commands/<name>.md` and open a " +
    "change request so I can review and merge it.",
  connector:
    "I want to connect an outside service to this project. Ask me which service " +
    "and what the agents should be able to do with it, then add the connector " +
    "with the Kortix CLI and tell me what still needs authorizing.",
  secret:
    "I want to add a secret to this project. Ask me what it is for and which " +
    "agents need it — never ask me to paste the value in chat — then create the " +
    "secret with the Kortix CLI, grant it to those agents, and tell me where to " +
    "enter the value.",
  trigger:
    "I want to set up a trigger for this project. Ask me what should run, which " +
    "agent should run it, and on what schedule or event, then create it with the " +
    "Kortix CLI and show me the result.",
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
