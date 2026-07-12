/**
 * The prompt a freshly-installed project/template gets seeded with as its first
 * session, so an agent wires up the thing you just installed instead of dumping
 * you on an empty project. Deliberately generic — the agent reads the project's
 * own `kortix.yaml` + `.kortix/` files in the sandbox rather than us parsing the
 * config here — and it defers to the installed agent's own guardrails (so e.g.
 * Website Studio still never contacts anyone or spends money without approval).
 */
export function buildTemplateSetupPrompt(title: string): string {
  const name = title.replaceAll('-', ' ');
  return [
    `You were just created from the "${name}" template. Everything it needs — its agent(s), skills, triggers, and the integrations it depends on — is already in this project's files.`,
    '',
    'Set it up so it is ready to run:',
    '1. Read `kortix.yaml` and the files under `.kortix/` to understand what this project is and what it needs.',
    '2. Connect the integrations it requires (connectors + secrets). Always mint a setup link with the `request_secret` / `connect` tools (or `kortix secrets request` / `kortix connectors link`) — never ask me to paste a raw key into chat.',
    '3. Leave any triggers that are off by default off, and ask before enabling anything that sends messages, spends money, or contacts people.',
    '4. When it is wired up, tell me in plain language what now works and what (if anything) you still need from me to go live.',
    '',
    "Follow the guardrails in the agent's own instructions, and don't push to main without a change request.",
  ].join('\n');
}
