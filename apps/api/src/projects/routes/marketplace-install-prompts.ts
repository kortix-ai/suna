/**
 * Pure prompt builder for the agent-driven marketplace install-session. Kept in
 * its own leaf module (no config/db imports) so the template semantics can be
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

/** A use-case template: its `registryDependencies` (an agent + a skill) plus a
 *  `meta.template` block (agent grants, connectors, a scheduled trigger whose
 *  string fields carry `{{input}}` placeholders) and declared `inputs`. Installed
 *  conversationally through the existing marketplace: the agent reads the template
 *  and its parts with the `kortix marketplace` CLI, collects the inputs, installs
 *  the parts, wires the schedule + grants + secrets, and ships the trigger DISABLED
 *  until the user says go. This prompt supplies the template semantics (inputs,
 *  trigger wiring, the exact ids to install) that a plain item install ignores —
 *  it does NOT re-implement fetching; the agent uses its CLI for that. */
export function buildTemplateInstallPrompt(entry: TemplateCatalogEntry, id: string): string {
  const item = entry.item;
  const tpl = item.meta?.template ?? {};
  // Dependencies are named within the same registry as the template, so give the
  // agent their fully-qualified ids to install — no searching/guessing.
  const namespace = id.includes(':') ? id.slice(0, id.indexOf(':')) : '';
  const depIds = (item.registryDependencies ?? []).map((d) => (namespace ? `${namespace}:${d}` : d));
  const secrets = Object.keys(item.envVars ?? {});
  const connectors = (tpl.connectors ?? []).map((c) => c.app ?? c.slug);
  const channels = tpl.channels ?? [];

  const steps: string[] = [
    `Read the template first with the marketplace CLI — \`kortix marketplace show ${id}\` — to see its declared inputs, its scheduled trigger and agent grants (under \`meta.template\`), and the secrets/connectors it needs. Then tell me in a line or two what it adds and what you'll need from me.`,
    'Ask me for each input the template declares, pre-filling its default.',
  ];
  if (depIds.length) {
    steps.push(
      `Install its parts through the marketplace — the items ${depIds.map((d) => `\`${d}\``).join(', ')} — exactly the way you install any marketplace item with the CLI. They are the agent + skill this template runs on; don't hunt for them elsewhere.`,
    );
  }
  steps.push(
    'Wire the template\'s trigger (from `meta.template.triggers`) into this project\'s `kortix.yaml`, rendering my input values into it (replace every `{{key}}` with what I gave you), and ship it **DISABLED** (`enabled: false`). Add the matching agent grant under `agents:`.',
  );
  const needs = [
    secrets.length ? `secrets ${secrets.join(', ')} (Settings → Secrets)` : null,
    connectors.length ? `connectors ${connectors.join(', ')} (Settings → Connectors)` : null,
    channels.length ? `a ${channels.join('/')} channel (Settings → Channels)` : null,
  ].filter(Boolean);
  if (needs.length) {
    steps.push(
      `Walk me through connecting what it needs — ${needs.join('; ')}. Mint setup links with the \`request_secret\` / \`connect\` tools — never ask me to paste a raw key into the chat.`,
    );
  }
  steps.push(
    'Only after I confirm and the required accounts are connected, enable the trigger (`enabled: true`) and commit. Never enable it while a required secret or connector is still missing.',
    "Confirm it's live and tell me when it first runs.",
  );

  return [
    `Install the "${item.title ?? item.name}" automation into THIS project — as a short guided conversation, not a form.`,
    '',
    item.description ?? '',
    '',
    `This is a use-case template (marketplace id "${id}"). Set it up like this — and don't run anything until I say go:`,
    '',
    ...steps.map((s, i) => `${i + 1}. ${s}`),
  ].join('\n');
}
