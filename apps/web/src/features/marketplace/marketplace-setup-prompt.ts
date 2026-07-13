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

/**
 * The first-session prompt for a brand-new project (NOT cloned from a marketplace
 * item). This is the "agent creation" default — rather than dropping the user on
 * an empty project, the first session onboards + personalizes: it reads the
 * `kortix-onboarding` skill, learns what the user does, tailors the preloaded
 * starter kit to them, and aims at one real first result.
 */
export function buildProjectOnboardingPrompt(projectName: string): string {
  const name = projectName.replaceAll('-', ' ').trim() || 'this project';
  return [
    `This is a brand-new Kortix project ("${name}") — it ships with the full starter skill kit (research, documents, slides, spreadsheets, the web, browser automation, and more) already installed.`,
    '',
    'Onboard me and make this project mine:',
    '1. Read the `kortix-onboarding` skill and follow it.',
    '2. Ask me — briefly — what I do and what I want to get done here, so you can tailor the starter to my work. One or two questions, not an interrogation.',
    '3. Get me one real, finished result fast (a document, a bit of research, a small site, a populated sheet — whatever fits what I told you). The finished thing is the point, not a feature tour.',
    '4. Only surface deeper capabilities (connectors, memory, triggers, subagents, the marketplace) when the task in front of us actually calls for it.',
    '',
    'Everything runs in this sandbox and nothing becomes permanent until I approve a change request, so feel free to work on something real.',
  ].join('\n');
}
