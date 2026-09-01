/**
 * Prompt builders for the agent-driven craft install and uninstall.
 *
 * A leaf module — no config, no db imports — so the install SEMANTICS are
 * unit-testable without booting the API's env graph.
 *
 * Why an agent and not a deterministic merge: installing a craft is
 * judgment-heavy. Does its agent name collide with one already here? Does the
 * target project want its `default_agent` changed (it does not)? Which of the
 * craft's connectors does this project already have connected? A blind file
 * copy gets all three wrong, so an agent reads BOTH manifests and lands a
 * change request a human can review.
 *
 * The prompt embeds everything the agent needs — the craft's own manifest, the
 * target's manifest, the pinned sha, and the exact raw URLs — because the
 * alternative is an agent guessing or searching. That is the lesson
 * `buildTemplateInstallPrompt` already records: "Everything you need is in that
 * one response; do not search the repo or the web for it."
 */

import { serializeManifestObject } from '@kortix/manifest-schema';

/**
 * How much of an UPLOAD's file content the install prompt may embed.
 *
 * An upload has no repository, so its files travel to the agent inside the
 * prompt — there is nowhere else for them to come from. That makes the prompt
 * the real constraint, and it is much tighter than the archive cap: 400 KB of
 * text is roughly 100k tokens, which leaves an agent room to actually work.
 * The archive cap is 5 MB (`CRAFT_ZIP_LIMITS`), so the two are deliberately
 * different numbers — a craft may be STORED larger than one install can carry.
 *
 * Past the budget the prompt names the files it omitted instead of silently
 * truncating. An agent told "here are 40 of 60 files" can stop and say so; an
 * agent handed a quietly-cut file set writes a broken craft and reports success.
 */
export const CRAFT_INSTALL_EMBED_BUDGET = 400_000;

/** True when this upload carries more text than one install prompt can embed. */
export function craftExceedsEmbedBudget(
  files: ReadonlyArray<{ path: string; content: string }>,
): boolean {
  return files.reduce((total, file) => total + file.content.length, 0) > CRAFT_INSTALL_EMBED_BUDGET;
}

/** One craft, as the install prompt needs to see it. */
export interface CraftInstallSubject {
  slug: string;
  title: string;
  description: string | null;
  /**
   * `github` — the files live in a repo and the agent fetches them at
   * `resolvedSha`. `upload` — there is no repo, so `files` carries them and the
   * prompt embeds them verbatim (the shape
   * `buildRegistryProjectInstallPrompt` already uses for a base registry item).
   */
  sourceKind: 'github' | 'upload';
  repoOwner: string | null;
  repoName: string | null;
  /** The branch/tag asked for, or null for the default branch. */
  gitRef: string | null;
  /** The commit the install pins. Null only for a row crawled before shas. */
  resolvedSha: string | null;
  /** The craft's own kortix.yaml, as cached by the index crawl. */
  manifest: Record<string, unknown>;
  /** For an upload: the craft's text files, embedded below. Empty for github. */
  files?: Array<{ path: string; content: string }>;
  /** For an upload: the archive's original filename, for provenance. */
  uploadName?: string | null;
  /** The manifest's path inside the craft, so it is not embedded twice. */
  manifestPath?: string;
  /** Derived lists from the crawl, for the summary the agent opens with. */
  agents: Array<{ name: string }>;
  triggers: Array<{ slug: string; name?: string; type?: string; cron?: string | null }>;
  connectors: Array<{ slug: string; provider?: string; app?: string | null }>;
  skills: string[];
  envRequired: string[];
}

const RAW_BASE = 'https://raw.githubusercontent.com';

/** `owner/repo`, or the archive name for an upload. */
export function craftRepoSlug(
  craft: Pick<CraftInstallSubject, 'repoOwner' | 'repoName'> & { uploadName?: string | null },
): string {
  if (craft.repoOwner && craft.repoName) return `${craft.repoOwner}/${craft.repoName}`;
  return craft.uploadName ?? '(uploaded archive)';
}

/**
 * The git ref the agent must read the craft's files at.
 *
 * The pinned sha when we have one, so the files the agent copies are the exact
 * ones the index card was derived from. Falling back to a branch is a last
 * resort: a branch moves, so the agent could copy files that never matched the
 * manifest we showed it.
 */
export function craftFetchRef(craft: CraftInstallSubject): string {
  return craft.resolvedSha ?? craft.gitRef ?? 'HEAD';
}

/** The raw-content base the agent fetches the craft's files from, pinned. */
export function craftRawBase(craft: CraftInstallSubject): string {
  return `${RAW_BASE}/${craftRepoSlug(craft)}/${craftFetchRef(craft)}`;
}

/** Serialize the cached manifest back to YAML for the prompt. */
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
export function buildCraftInstallPrompt(
  craft: CraftInstallSubject,
  targetManifestRaw: string | null,
): string {
  const repo = craftRepoSlug(craft);
  const ref = craftFetchRef(craft);
  const rawBase = craftRawBase(craft);
  const triggerSlugs = craft.triggers.map((t) => t.slug).filter(Boolean);
  const agentNames = craft.agents.map((a) => a.name).filter(Boolean);
  const connectorSlugs = craft.connectors.map((c) => c.slug).filter(Boolean);

  const lines: string[] = [
    `Install the "${craft.title}" craft into THIS project — as a short guided conversation, not a form.`,
    '',
    craft.description ?? '',
    '',
    craft.sourceKind === 'upload'
      ? `This craft was UPLOADED as ${repo} — there is no repository behind it. Every file it contains is embedded below; do not go looking for a repo or a raw URL, there is none.`
      : `The craft lives at ${repo}, pinned to \`${ref}\`. Read its files at that exact ref (\`${rawBase}/<path>\`) — a branch moves, and the manifest below is what that commit actually declares.`,
    '',
    "The craft's own kortix.yaml:",
    '```yaml',
    manifestYaml(craft.manifest),
    '```',
    '',
    "This project's current kortix.yaml — this is what you must not break:",
    '```yaml',
    targetManifestRaw ?? '(no manifest yet — this project has none, so you are creating it)',
    '```',
    '',
  ];

  if (craft.sourceKind === 'upload') {
    const files = (craft.files ?? []).filter(
      (f) => f.path !== (craft.manifestPath ?? 'kortix.yaml'),
    );
    // Smallest first, so a budget that runs out sacrifices the biggest files
    // rather than whatever happened to sort last — and a craft whose real
    // content is small still arrives complete even when one fixture is huge.
    const ordered = [...files].sort((a, b) => a.content.length - b.content.length);
    const embedded: typeof ordered = [];
    const omitted: typeof ordered = [];
    let used = 0;
    for (const file of ordered) {
      if (used + file.content.length > CRAFT_INSTALL_EMBED_BUDGET) {
        omitted.push(file);
        continue;
      }
      embedded.push(file);
      used += file.content.length;
    }

    lines.push(
      `Its ${embedded.length} file${embedded.length === 1 ? '' : 's'}, verbatim. These ARE the craft — copy from here, not from anywhere else:`,
      '',
    );
    for (const file of embedded) {
      lines.push(`--- ${file.path} ---`, '```', file.content, '```', '');
    }

    if (omitted.length > 0) {
      // Named, not silently dropped. The agent must be able to tell the user
      // the craft is incomplete rather than write a broken one and report done.
      lines.push(
        `NOT INCLUDED — ${omitted.length} file${omitted.length === 1 ? '' : 's'} exceeded this prompt's size budget:`,
        ...omitted.map((file) => `  - ${file.path} (${Math.round(file.content.length / 1024)} KB)`),
        '',
        'This craft was uploaded as an archive, so there is no repository to read those from. Install everything above, then STOP and tell me exactly which files are missing and that the craft is incomplete. Do not invent their contents, and do not report the install as complete.',
        '',
      );
    }
  }

  lines.push('What it contributes:');

  const contributes: string[] = [];
  if (agentNames.length) contributes.push(`agents: ${agentNames.join(', ')}`);
  if (craft.skills.length) contributes.push(`skills: ${craft.skills.join(', ')}`);
  if (connectorSlugs.length) contributes.push(`connectors: ${connectorSlugs.join(', ')}`);
  if (triggerSlugs.length) contributes.push(`triggers: ${triggerSlugs.join(', ')}`);
  lines.push(...bulletList(contributes.length ? contributes : ['nothing declared']));

  const steps: string[] = [
    'Tell me in a line or two what this craft does and what you will need from me. Everything you need is above — do not search the web for it.',
    `Read what is already here: this project's kortix.yaml (above), \`.kortix/opencode/agents/\`, and \`.kortix/opencode/skills/\`. You are MERGING into a live project, not scaffolding a new one.`,
  ];

  if (agentNames.length) {
    const agentSource =
      craft.sourceKind === 'upload'
        ? 'the embedded `.kortix/opencode/agents/<name>.md` blocks above'
        : `\`${rawBase}/.kortix/opencode/agents/<name>.md\``;
    steps.push(
      `Copy the craft's agent files from ${agentSource} into this project's \`.kortix/opencode/agents/\`. **Rename on collision** — if this project already has an agent by that name, install the craft's under a suffixed name and use the new name everywhere below. Never remove or overwrite an existing agent, and never change \`default_agent\`.`,
    );
  }
  if (craft.skills.length) {
    const skillSource =
      craft.sourceKind === 'upload'
        ? 'the embedded `.kortix/opencode/skills/<name>/` blocks above'
        : `\`${rawBase}/.kortix/opencode/skills/<name>/\``;
    steps.push(
      `Copy the skills it grants (${craft.skills.join(', ')}) from ${skillSource} into this project's \`.kortix/opencode/skills/\`. A skill this project already has by the same name: leave the existing one alone and say so.`,
    );
  }
  steps.push(
    `Merge the craft's \`agents:\` governance blocks into this project's kortix.yaml — its grants only, under the (possibly renamed) agent name. Leave every existing agent and \`default_agent\` untouched.`,
  );
  if (connectorSlugs.length) {
    steps.push(
      `Merge its \`connectors:\` entries (${connectorSlugs.join(', ')}). If this project already declares a connector with the same slug, KEEP the existing one — it may already be connected — and reuse that slug in the agent grants rather than redefining it.`,
    );
  }
  if (triggerSlugs.length) {
    steps.push(
      'Merge its `triggers:` entries and ship every one **`enabled: false`**. A craft never starts firing because it was installed; it starts firing because I said go.',
    );
  }

  // The ownership record. This is what makes `git revert` a working uninstall
  // and what the run report joins against, so it is spelled out exactly rather
  // than left for the agent to infer.
  steps.push(
    [
      "Record the install in this project's kortix.yaml so it is reversible and so its runs can be reported. Add a `crafts:` entry:",
      '',
      '```yaml',
      'crafts:',
      `  - slug: ${craft.slug}`,
      ...(craft.sourceKind === 'upload'
        ? [
            // An upload has no `owner/repo`, and the manifest schema requires
            // `repo` to BE one — so record the provenance in `title` and leave
            // `repo` off rather than inventing a repository that does not exist.
            `    # uploaded archive: ${repo} — no repo, so no \`repo:\`/\`sha:\` to record`,
          ]
        : [`    repo: ${repo}`]),
      ...(craft.gitRef ? [`    ref: ${craft.gitRef}`] : []),
      ...(craft.resolvedSha ? [`    sha: ${craft.resolvedSha}`] : []),
      `    title: ${craft.title}`,
      '    installed_at: <this instant, ISO-8601>',
      '    owns:',
      ...(agentNames.length
        ? ['      agents: [<the agent names you actually used, after any rename>]']
        : []),
      ...(craft.skills.length ? ['      skills: [<the skills you actually installed>]'] : []),
      ...(connectorSlugs.length ? ['      connectors: [<the connectors you actually added>]'] : []),
      ...(triggerSlugs.length ? ['      triggers: [<the trigger slugs you actually added>]'] : []),
      '```',
      '',
      '`owns` must list what you ACTUALLY landed, after renames and after skipping anything that already existed — it is what an uninstall removes.',
    ].join('\n'),
  );

  steps.push(
    `Stamp \`craft: ${craft.slug}\` on every entry you added — each trigger, each connector, and each \`agents:\` block. The trigger one is load-bearing: the platform reads it to attribute runs to this craft, so a trigger without it will fire but never appear in the craft's run history.`,
  );

  const needs: string[] = [];
  if (craft.envRequired.length) {
    needs.push(`secrets ${craft.envRequired.join(', ')}`);
  }
  if (connectorSlugs.length) {
    needs.push(`connectors ${connectorSlugs.join(', ')}`);
  }
  if (needs.length) {
    steps.push(
      `Walk me through connecting what it needs — ${needs.join('; ')}. Mint setup links with the \`request_secret\` / \`connect\` tools — never ask me to paste a raw key into the chat. Check first whether this project already has each one; do not ask me for something I have already connected.`,
    );
  }

  steps.push(
    'Validate before you commit: `kortix validate`. A craft that lands an invalid manifest breaks the whole project, not just itself.',
    'Open a change request with the result — do not push directly to the default branch.',
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
          "- Tell me when it will first run, and that I can watch it under the craft's runs.",
        ]
      : ['- Tell me what the craft can now do and how to use it.']),
    '- If you do not have permission to merge, say exactly which button is needed in the UI: Apply the CR. Do not merely say "merge it" without naming the action.',
  );

  return lines.join('\n');
}

/**
 * The uninstall prompt.
 *
 * Driven by the `owns` map the install recorded, which is why the install is
 * required to make it truthful. Deliberately an agent and not a mechanical
 * delete: a file may have been edited since it landed, an agent may have been
 * renamed on the way in, and a connector may be shared with something else in
 * the project by now.
 */
export function buildCraftUninstallPrompt(
  craft: Pick<CraftInstallSubject, 'slug' | 'title'> & {
    owns: Partial<Record<'agents' | 'skills' | 'connectors' | 'triggers', string[]>>;
    repoOwner: string;
    repoName: string;
  },
  targetManifestRaw: string | null,
): string {
  const owned = Object.entries(craft.owns).filter(([, list]) => (list ?? []).length > 0);
  const lines: string[] = [
    `Uninstall the "${craft.title}" craft from THIS project.`,
    '',
    `It was installed from ${craftRepoSlug(craft)} and this project's kortix.yaml records what it contributed under \`crafts:\` (slug \`${craft.slug}\`).`,
    '',
    "This project's current kortix.yaml:",
    '```yaml',
    targetManifestRaw ?? '(no manifest found)',
    '```',
    '',
  ];

  if (owned.length === 0) {
    lines.push(
      `Its \`owns\` map lists nothing, so there may be nothing to remove beyond the \`crafts:\` entry itself. Confirm that by searching the manifest for \`craft: ${craft.slug}\` before you conclude it.`,
      '',
    );
  } else {
    lines.push(
      'It contributed:',
      ...bulletList(owned.map(([kind, list]) => `${kind}: ${(list ?? []).join(', ')}`)),
      '',
    );
  }

  lines.push(
    'Do this:',
    '',
    `1. Cross-check \`owns\` against the manifest: everything carrying \`craft: ${craft.slug}\` belongs to this craft. If the two disagree, trust \`craft:\` on the entry and tell me about the mismatch — it means someone hand-edited one side.`,
    '2. Remove the triggers it owns FIRST, so nothing fires mid-uninstall.',
    '3. Remove its agent governance blocks and agent files, and its skills. Leave anything this project also uses on its own — if a connector or skill is referenced by an agent this craft did not contribute, keep it and say so.',
    '4. A connector it added may be CONNECTED and hold credentials. Do not revoke anything: remove the manifest entry only, and tell me if I should disconnect it separately.',
    `5. Remove the \`crafts:\` entry for \`${craft.slug}\`.`,
    '6. `kortix validate`, then open a change request. Do not push directly to the default branch.',
    '',
    'Show me the CR and what it removes before asking whether to merge. Do not merge without my explicit approval.',
  );

  return lines.join('\n');
}

// ── authoring ───────────────────────────────────────────────────────────────

/** What the author prompt needs to know about where the craft will live. */
export interface CraftAuthorSubject {
  /** What the person asked for, verbatim. */
  description: string;
  /** The project the authoring session runs in — the craft is BUILT here. */
  projectName: string;
  /** How to publish when it is done. `owner/repo` once the repo exists. */
  accountSlug?: string | null;
}

/**
 * Prompt for "grow your crafts" — describe a craft, Kortix builds it.
 *
 * This is the inverse of the install prompt: install merges an existing craft
 * INTO a project, authoring produces a new craft FROM a description. Both are
 * agent-driven, and for the same reason — deciding which agent, which skills,
 * and what cadence a described job needs is judgment, not a template.
 *
 * The prompt is deliberately opinionated about ORDER: repo first, manifest
 * second, `kortix validate` third, publish last. Publishing an unvalidated
 * craft puts a broken card in the store, and the store's own crawl would then
 * mark it `unavailable` — which the author sees as "my craft broke" rather
 * than "I skipped validate".
 *
 * It never asks the person to paste a secret. `request_secret` and `connect`
 * exist precisely so a credential goes into the project's secret store and not
 * into a chat transcript, and every other prompt in this file holds that line.
 */
export function buildCraftAuthorPrompt(subject: CraftAuthorSubject): string {
  const lines: string[] = [
    'Build a new Kortix CRAFT from this description, then publish it to the craft store.',
    '',
    'What I asked for:',
    '```',
    subject.description.trim(),
    '```',
    '',
    'A craft is a Kortix project you can install into another project. It is a repository whose `kortix.yaml` declares the agents, skills, connectors and triggers that do the job. Installing it merges those declarations into the target project.',
    '',
    'Do this, in order:',
    '',
    '1. **Restate the job in one sentence, then say what it needs.** Which agent does the work, which skills it needs, which third-party apps it must reach, and how often it should run. If the description is ambiguous on any of those four, ask me BEFORE writing files — one round of questions is far cheaper than a craft that does the wrong job.',
    '2. **Create the repository.** Use the managed repo flow (`POST /projects/create-repo` through the tooling available to you). Name it for the job, kebab-case.',
    "3. **Scaffold it** with `kortix init` so it starts from the current manifest version, then write the craft's own content:",
    '   - `kortix.yaml` — the agents, skills, connectors and triggers.',
    '   - `.kortix/opencode/agents/<name>.md` — one file per agent, with its instructions.',
    '   - `.kortix/opencode/skills/<name>/SKILL.md` — one directory per skill.',
    '   - `README.md` — what it does, what it needs connected, and what it will do on its first run. Someone deciding whether to install this reads the README, not the manifest.',
    '4. **Ship every trigger `enabled: false`.** A craft that starts firing the moment it is installed is a craft nobody trusts. The person installing it turns it on when they are ready.',
    '5. **Declare what it needs, do not embed it.** List required connectors in `connectors:` and required env in the manifest. Never write a credential, token, or API key into any file. If YOU need one to test, mint a link with `request_secret` or `connect` — never ask me to paste a key into the chat.',
    '6. **`kortix validate`.** Fix everything it reports. Do not go on until it passes: a craft that fails validate cannot be installed, and publishing it puts a broken card in the store.',
    '7. **Commit and push** to the default branch of the new repo.',
    '8. **Publish it** with `kortix crafts publish <owner>/<repo>`. It defaults to private — pass `--public` only if I said the craft should be public.',
    '',
    `You are working in the "${subject.projectName}" project. Build the craft in its own repository, NOT by editing this project's kortix.yaml — this project is where you work, not what you are shipping.`,
    '',
    'When it is published, show me: the repo, what the manifest declares, what a person has to connect before the first run, and the `kortix crafts publish` output. Then tell me how to install it.',
  ];
  return lines.join('\n');
}
