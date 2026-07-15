/**
 * Pure prompt builders for the agent-driven marketplace install-session. Kept in
 * their own leaf module (no config/db imports) so the template semantics can be
 * unit-tested without booting the API's env graph.
 */

interface TemplateInputDecl {
  key: string;
  label?: string;
  type?: string;
  default?: string;
  help?: string;
  required?: boolean;
}

interface TemplateCatalogEntry {
  item: {
    name: string;
    title?: string;
    description?: string | null;
    registryDependencies?: string[];
    inputs?: TemplateInputDecl[];
    envVars?: Record<string, string>;
    meta?: {
      template?: {
        agents?: Record<string, { secrets?: string[]; connectors?: string[]; skills?: string[] }>;
        connectors?: Array<{ slug: string; app?: string }>;
        channels?: string[];
        triggers?: Array<Record<string, unknown>>;
        env_optional?: string[];
      };
    };
  };
}

/** `@agents/x.md` → `.kortix/opencode/agents/x.md` etc. — the conventional layout
 *  so the agent writes files to the right place without guessing. */
function opencodePath(target: string): string {
  return target
    .replace(/^@agents\//, '.kortix/opencode/agents/')
    .replace(/^@skills\//, '.kortix/opencode/skills/')
    .replace(/^@commands\//, '.kortix/opencode/command/')
    .replace(/^@memory\//, '.kortix/memory/');
}

/** A use-case template: its `registryDependencies` (an agent + a skill) plus a
 *  `meta.template` block (agent grants, connectors, a scheduled trigger whose
 *  string fields carry `{{input}}` placeholders) and declared `inputs`. Installed
 *  conversationally — the agent collects the inputs, writes the parts (their file
 *  content is inlined below — no fetching/guessing), wires the schedule + grants +
 *  secrets, and ships the trigger DISABLED until the user says go. This is the one
 *  place that understands template semantics (inputs, trigger wiring) that a plain
 *  item install ignores.
 *
 *  `depFiles` are the resolved files of the template's `registryDependencies`
 *  (agent .md + skill files, with content), so everything the install needs is in
 *  the prompt itself. */
export function buildTemplateInstallPrompt(
  entry: TemplateCatalogEntry,
  id: string,
  depFiles: Array<{ path: string; content: string }> = [],
): string {
  const item = entry.item;
  const tpl = item.meta?.template ?? {};
  const inputs = item.inputs ?? [];
  const secrets = Object.keys(item.envVars ?? {});
  const connectors = (tpl.connectors ?? []).map((c) => c.app ?? c.slug);
  const channels = tpl.channels ?? [];
  const deps = item.registryDependencies ?? [];

  const lines: string[] = [
    `Install the "${item.title ?? item.name}" automation into THIS project — as a short guided conversation, not a form.`,
    '',
    item.description ?? '',
    '',
    `This is a use-case template (marketplace id "${id}"). Set it up like this — and don't run anything until I say go:`,
    '',
    "1. Tell me in a line or two what this adds (the agent, the schedule, what it does) and what you'll need from me (accounts, keys, a channel).",
  ];

  if (inputs.length) {
    lines.push('2. Ask me for each of these inputs, pre-filling the default:');
    for (const inp of inputs) {
      const bits = [inp.default != null ? `default: ${inp.default}` : null, inp.required === false ? 'optional' : null]
        .filter(Boolean)
        .join(', ');
      lines.push(`   - ${inp.key} — ${inp.label ?? inp.key}${bits ? ` (${bits})` : ''}${inp.help ? ` — ${inp.help}` : ''}`);
    }
  } else {
    lines.push('2. This template has no inputs to collect.');
  }

  if (depFiles.length) {
    lines.push(
      "3. Write these files into the project exactly as given — they are the agent + skill this template needs. Render any `{{projectName}}` to this project's name; don't rename or hunt for them elsewhere:",
    );
    for (const f of depFiles) {
      lines.push('', `--- ${opencodePath(f.path)} ---`, '```', f.content, '```');
    }
  } else if (deps.length) {
    lines.push(
      `3. Install its parts — the marketplace items ${deps.map((d) => `\`${d}\``).join(', ')}: fetch each one's source and place its files into this project, following the project's existing conventions.`,
    );
  }

  lines.push(
    '4. Wire the schedule into `kortix.yaml`, rendering my input values into it (replace every `{{key}}` with what I gave you), and ship the trigger **DISABLED** (`enabled: false`). Add exactly this trigger (and the matching agent grant under `agents:`):',
    '```json',
    JSON.stringify({ triggers: tpl.triggers ?? [], agents: tpl.agents ?? {} }, null, 2),
    '```',
  );

  const needs = [
    secrets.length ? `secrets ${secrets.join(', ')} (add in Settings → Secrets)` : null,
    connectors.length ? `connectors ${connectors.join(', ')} (Settings → Connectors)` : null,
    channels.length ? `a ${channels.join('/')} channel (Settings → Channels)` : null,
  ].filter(Boolean);
  if (needs.length) {
    lines.push(
      `5. Walk me through connecting what it needs — ${needs.join('; ')}. Mint setup links with the \`request_secret\` / \`connect\` tools — never ask me to paste a raw key into the chat.`,
    );
  }

  lines.push(
    `${needs.length ? '6' : '5'}. Only after I confirm and the required accounts are connected, enable the trigger (\`enabled: true\`) and commit. Never enable it while a required secret or connector is still missing.`,
    `${needs.length ? '7' : '6'}. Confirm it's live and tell me when it first runs.`,
  );

  return lines.join('\n');
}
