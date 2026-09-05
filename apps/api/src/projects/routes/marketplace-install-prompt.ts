/**
 * The prompt for the agent-driven template install.
 *
 * A leaf module — no config, no db imports — so the install SEMANTICS are
 * unit-testable without booting the API's env graph.
 *
 * Why an agent and not a deterministic merge: installing a template into a
 * LIVE project is judgment-heavy. Does its agent name collide with one already
 * here? Does the target project want its `default_agent` changed (it does not)?
 * Which of the template's connectors does this project already have connected?
 * A blind file copy gets all three wrong, so an agent reads BOTH manifests and
 * lands a change request a human can review.
 *
 * The prompt embeds everything the agent needs — the template's manifest, the
 * target's manifest, the pinned sha, and the exact raw URLs — because the
 * alternative is an agent guessing or searching.
 */

import { serializeManifestObject } from '@kortix/manifest-schema';
import type { MarketplaceCatalogEntry } from '../../marketplace/templates';

const RAW_BASE = 'https://raw.githubusercontent.com';

/**
 * The git ref the agent must read the template's files at.
 *
 * The pinned sha, so the files the agent copies are the exact ones the card was
 * derived from. Falling back to a branch is a last resort: a branch moves, so
 * the agent could copy files that never matched the manifest it was shown.
 */
export function marketplaceFetchRef(
  template: Pick<MarketplaceCatalogEntry, 'resolved_sha' | 'git_ref'>,
): string {
  return template.resolved_sha || template.git_ref || 'HEAD';
}

/** The raw-content base the agent fetches the template's files from, pinned. */
export function marketplaceRawBase(
  template: Pick<MarketplaceCatalogEntry, 'repo' | 'resolved_sha' | 'git_ref'>,
): string {
  return `${RAW_BASE}/${template.repo}/${marketplaceFetchRef(template)}`;
}

/** Serialize the catalog's manifest back to YAML for the prompt. */
function manifestYaml(manifest: Record<string, unknown>): string {
  try {
    return serializeManifestObject(manifest, 'yaml').trim();
  } catch {
    // A manifest that will not re-serialize is still readable as JSON, and the
    // agent has the raw URL either way. Never fail the install over formatting.
    return JSON.stringify(manifest, null, 2);
  }
}

function bulletList(items: string[]): string[] {
  return items.map((item) => `- ${item}`);
}

/**
 * The install prompt.
 *
 * `targetManifestRaw` is the project's CURRENT kortix.yaml, embedded verbatim so
 * the agent can see what it must not break. Null when the project has no
 * manifest yet (a brand-new repo), which the prompt states rather than hiding.
 */
export function buildMarketplaceInstallPrompt(
  template: MarketplaceCatalogEntry,
  targetManifestRaw: string | null,
): string {
  const ref = marketplaceFetchRef(template);
  const rawBase = marketplaceRawBase(template);
  const triggerSlugs = template.triggers.map((t) => t.slug).filter(Boolean);
  const agentNames = template.agents.map((a) => a.name).filter(Boolean);
  const connectorSlugs = template.connectors.map((c) => c.slug).filter(Boolean);

  const lines: string[] = [
    `Install the "${template.title}" template into THIS project — as a short guided conversation, not a form.`,
    '',
    template.description ?? '',
    '',
    `The template lives at ${template.repo}, pinned to \`${ref}\`. Read its files at that exact ref (\`${rawBase}/<path>\`) — a branch moves, and the manifest below is what that commit actually declares.`,
    '',
    "The template's own kortix.yaml:",
    '```yaml',
    manifestYaml(template.manifest),
    '```',
    '',
    "This project's current kortix.yaml — this is what you must not break:",
    '```yaml',
    targetManifestRaw ?? '(no manifest yet — this project has none, so you are creating it)',
    '```',
    '',
    'What it contributes:',
  ];

  const contributes: string[] = [];
  if (agentNames.length) contributes.push(`agents: ${agentNames.join(', ')}`);
  if (template.skills.length) contributes.push(`skills: ${template.skills.join(', ')}`);
  if (connectorSlugs.length) contributes.push(`connectors: ${connectorSlugs.join(', ')}`);
  if (triggerSlugs.length) contributes.push(`triggers: ${triggerSlugs.join(', ')}`);
  lines.push(...bulletList(contributes.length ? contributes : ['nothing declared']));

  const steps: string[] = [
    'Tell me in a line or two what this template does and what you will need from me. Everything you need is above — do not search the web for it.',
    "Read what is already here: this project's kortix.yaml (above), `.kortix/opencode/agents/`, and `.kortix/opencode/skills/`. You are MERGING into a live project, not scaffolding a new one.",
  ];

  if (agentNames.length) {
    steps.push(
      `Copy the template's agent files from \`${rawBase}/.kortix/opencode/agents/<name>.md\` into this project's \`.kortix/opencode/agents/\`. **Rename on collision** — if this project already has an agent by that name, install the template's under a suffixed name and use the new name everywhere below. Never remove or overwrite an existing agent, and never change \`default_agent\`.`,
    );
  }
  if (template.skills.length) {
    steps.push(
      `Copy the skills it grants (${template.skills.join(', ')}) from \`${rawBase}/.kortix/opencode/skills/<name>/\` into this project's \`.kortix/opencode/skills/\`. A skill this project already has by the same name: leave the existing one alone and say so.`,
    );
  }
  steps.push(
    "Merge the template's `agents:` governance blocks into this project's kortix.yaml — its grants only, under the (possibly renamed) agent name. Leave every existing agent and `default_agent` untouched.",
  );
  if (connectorSlugs.length) {
    steps.push(
      `Merge its \`connectors:\` entries (${connectorSlugs.join(', ')}). If this project already declares a connector with the same slug, KEEP the existing one — it may already be connected — and reuse that slug in the agent grants rather than redefining it.`,
    );
  }
  if (triggerSlugs.length) {
    steps.push(
      'Merge its `triggers:` entries and ship every one **`enabled: false`**. A template never starts firing because it was installed; it starts firing because I said go.',
    );
  }

  const needs: string[] = [];
  if (template.env_required.length) needs.push(`secrets ${template.env_required.join(', ')}`);
  if (connectorSlugs.length) needs.push(`connectors ${connectorSlugs.join(', ')}`);
  if (needs.length) {
    steps.push(
      `Walk me through connecting what it needs — ${needs.join('; ')}. Mint setup links with the \`request_secret\` / \`connect\` tools — never ask me to paste a raw key into the chat. Check first whether this project already has each one; do not ask me for something I have already connected.`,
    );
  }

  steps.push(
    'Validate before you commit: `kortix validate`. A template that lands an invalid manifest breaks the whole project, not just itself.',
    'Open a change request with the result — do not push directly to the default branch. Keep everything the template adds in that ONE change request: reverting it later is how the template is removed.',
  );

  lines.push('', 'Do this:', '', ...steps.map((s, i) => `${i + 1}. ${s}`));

  lines.push(
    '',
    'After the change request is open, keep driving the install instead of leaving me with manual handoff work:',
    '',
    '- Show the CR number/status and ask whether to apply/merge it now. Do not merge without my explicit approval.',
    '- If I approve and your Kortix grant allows it, merge it yourself with `kortix cr merge <number-or-id>`.',
    ...(triggerSlugs.length
      ? [
          `- Only after the merge, and only once every required secret and connector resolves, ask me whether to enable ${triggerSlugs.length === 1 ? 'the trigger' : 'the triggers'}. Enable by setting \`enabled: true\` in kortix.yaml — never while something it needs is still missing.`,
          '- Tell me when it will first run, and that I can watch it under Triggers.',
        ]
      : ['- Tell me what the template can now do and how to use it.']),
    '- If you do not have permission to merge, say exactly which button is needed in the UI: Apply the CR. Do not merely say "merge it" without naming the action.',
    '- Tell me that removing the template later is one step: revert that change request.',
  );

  return lines.join('\n');
}
