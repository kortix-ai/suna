/**
 * The subproject install/uninstall prompts ARE the contract with the installing
 * agent. There is no deterministic merge behind them, so anything the prompt
 * fails to say is a thing the install will get wrong — silently, and only on
 * some projects.
 *
 * These tests pin the instructions that are load-bearing rather than the
 * wording around them: the pinned ref, the ownership stamp, triggers shipping
 * disabled, `default_agent` being off-limits, rename-on-collision, and the
 * `owns` map reflecting what actually landed.
 */
import { describe, expect, test } from 'bun:test';
import {
  SUBPROJECT_INSTALL_EMBED_BUDGET,
  type SubprojectInstallSubject,
  buildSubprojectInstallPrompt,
  buildSubprojectUninstallPrompt,
  subprojectExceedsEmbedBudget,
  subprojectFetchRef,
  subprojectRawBase,
} from './subproject-install-prompts';

const SHA = '9f3c1a7ecb4d21f0a8b3c5d7e9f1a2b3c4d5e6f7';

function subject(overrides: Partial<SubprojectInstallSubject> = {}): SubprojectInstallSubject {
  return {
    slug: 'seo-watch',
    title: 'SEO watch',
    description: 'Audits the site weekly and opens a change request.',
    sourceKind: 'github',
    repoOwner: 'acme',
    repoName: 'seo-subproject',
    gitRef: 'main',
    resolvedSha: SHA,
    manifest: {
      kortix_version: 2,
      default_agent: 'seo-writer',
      agents: { 'seo-writer': { skills: ['seo-audit'] } },
      triggers: [
        {
          slug: 'seo-weekly',
          type: 'cron',
          agent: 'seo-writer',
          cron: '0 0 9 * * 1',
          prompt: 'Audit.',
        },
      ],
    },
    agents: [{ name: 'seo-writer' }],
    triggers: [{ slug: 'seo-weekly', name: 'Weekly SEO', type: 'cron', cron: '0 0 9 * * 1' }],
    connectors: [{ slug: 'search-console', provider: 'composio', app: 'google_search_console' }],
    skills: ['seo-audit'],
    envRequired: ['SEARCH_CONSOLE_KEY'],
    ...overrides,
  };
}

const TARGET = `kortix_version: 2
default_agent: kortix
agents:
  kortix:
    connectors: all
`;

describe('buildSubprojectInstallPrompt — provenance', () => {
  test('reads the subproject at the pinned SHA, not at the branch', () => {
    const p = buildSubprojectInstallPrompt(subject(), TARGET);
    expect(p).toContain(SHA);
    expect(p).toContain(`https://raw.githubusercontent.com/acme/seo-subproject/${SHA}`);
    // A branch would let the agent copy files that never matched the manifest
    // it was shown.
    expect(p).not.toContain('raw.githubusercontent.com/acme/seo-subproject/main');
  });

  test('falls back to the branch only when no sha was recorded', () => {
    const subproject = subject({ resolvedSha: null });
    expect(subprojectFetchRef(subproject)).toBe('main');
    expect(subprojectRawBase(subproject)).toBe('https://raw.githubusercontent.com/acme/seo-subproject/main');
  });

  test('falls back to HEAD when there is neither a sha nor a ref', () => {
    expect(subprojectFetchRef(subject({ resolvedSha: null, gitRef: null }))).toBe('HEAD');
  });

  test("embeds BOTH manifests — the subproject's and the target's", () => {
    const p = buildSubprojectInstallPrompt(subject(), TARGET);
    expect(p).toContain('default_agent: seo-writer'); // the subproject's
    expect(p).toContain('default_agent: kortix'); // the target's
    expect(p).toContain('what you must not break');
  });

  test('a project with no manifest yet is stated, not hidden', () => {
    const p = buildSubprojectInstallPrompt(subject(), null);
    expect(p).toContain('no manifest yet');
  });

  test('tells the agent everything it needs is in the prompt', () => {
    expect(buildSubprojectInstallPrompt(subject(), TARGET)).toContain('do not search the web');
  });
});

describe('buildSubprojectInstallPrompt — the ownership record', () => {
  test('spells out the `subprojects:` entry with repo, ref and sha', () => {
    const p = buildSubprojectInstallPrompt(subject(), TARGET);
    expect(p).toContain('subprojects:');
    expect(p).toContain('- slug: seo-watch');
    expect(p).toContain('repo: acme/seo-subproject');
    expect(p).toContain('ref: main');
    expect(p).toContain(`sha: ${SHA}`);
  });

  test('omits ref and sha when the subproject has none', () => {
    const p = buildSubprojectInstallPrompt(subject({ gitRef: null, resolvedSha: null }), TARGET);
    expect(p).not.toContain('    ref:');
    expect(p).not.toContain('    sha:');
    expect(p).toContain('repo: acme/seo-subproject');
  });

  test('requires `owns` to reflect what ACTUALLY landed, after renames', () => {
    const p = buildSubprojectInstallPrompt(subject(), TARGET);
    expect(p).toContain('owns:');
    expect(p).toContain('after any rename');
    expect(p).toContain('ACTUALLY landed');
  });

  test('demands the subproject: stamp and says why the trigger one matters', () => {
    const p = buildSubprojectInstallPrompt(subject(), TARGET);
    expect(p).toContain('subproject: seo-watch');
    // If the agent omits it the trigger still fires, so the prompt has to make
    // the consequence explicit or it reads as optional bookkeeping.
    expect(p).toContain("never appear in the subproject's run history");
  });
});

describe('buildSubprojectInstallPrompt — the merge must not break the project', () => {
  test('never changes default_agent', () => {
    const p = buildSubprojectInstallPrompt(subject(), TARGET);
    expect(p).toContain('never change `default_agent`');
  });

  test('renames a colliding agent rather than overwriting', () => {
    const p = buildSubprojectInstallPrompt(subject(), TARGET);
    expect(p).toContain('Rename on collision');
    expect(p).toContain('Never remove or overwrite an existing agent');
  });

  test('keeps an existing connector rather than redefining it', () => {
    // The existing one may already hold credentials.
    const p = buildSubprojectInstallPrompt(subject(), TARGET);
    expect(p).toContain('KEEP the existing one');
  });

  test('validates before committing', () => {
    expect(buildSubprojectInstallPrompt(subject(), TARGET)).toContain('kortix validate');
  });

  test('opens a change request and never pushes to the default branch', () => {
    const p = buildSubprojectInstallPrompt(subject(), TARGET);
    expect(p).toContain('Open a change request');
    expect(p).toContain('do not push directly to the default branch');
    expect(p).toContain('Do not merge without my explicit approval');
  });
});

describe('buildSubprojectInstallPrompt — nothing starts firing on install', () => {
  test('every trigger ships disabled', () => {
    const p = buildSubprojectInstallPrompt(subject(), TARGET);
    expect(p).toContain('`enabled: false`');
    expect(p).toContain('starts firing because I said go');
  });

  test('enabling comes after the merge and only once requirements resolve', () => {
    const p = buildSubprojectInstallPrompt(subject(), TARGET);
    expect(p).toContain('Only after the merge');
    expect(p).toContain('never while something it needs is still missing');
  });

  test('a subproject with no triggers gets no enable step at all', () => {
    const p = buildSubprojectInstallPrompt(subject({ triggers: [] }), TARGET);
    expect(p).not.toContain('enabled: false');
    expect(p).toContain('what the subproject can now do');
  });
});

describe('buildSubprojectInstallPrompt — credentials', () => {
  test('names the secrets and connectors, and forbids pasting a raw key', () => {
    const p = buildSubprojectInstallPrompt(subject(), TARGET);
    expect(p).toContain('SEARCH_CONSOLE_KEY');
    expect(p).toContain('search-console');
    expect(p).toContain('request_secret');
    expect(p).toContain('never ask me to paste a raw key');
  });

  test('tells the agent not to re-ask for something already connected', () => {
    expect(buildSubprojectInstallPrompt(subject(), TARGET)).toContain('already connected');
  });

  test('a subproject needing nothing gets no credential walkthrough', () => {
    const p = buildSubprojectInstallPrompt(subject({ envRequired: [], connectors: [] }), TARGET);
    expect(p).not.toContain('request_secret');
  });
});

describe('buildSubprojectInstallPrompt — only the steps that apply', () => {
  test('a subproject with no skills gets no skill-copy step', () => {
    const p = buildSubprojectInstallPrompt(subject({ skills: [] }), TARGET);
    expect(p).not.toContain('opencode/skills/<name>/');
  });

  test('a subproject with no agents gets no agent-copy step', () => {
    const p = buildSubprojectInstallPrompt(subject({ agents: [] }), TARGET);
    expect(p).not.toContain('agents/<name>.md');
  });

  test('a subproject that declares nothing still produces a coherent prompt', () => {
    const p = buildSubprojectInstallPrompt(
      subject({ agents: [], triggers: [], connectors: [], skills: [], envRequired: [] }),
      TARGET,
    );
    expect(p).toContain('nothing declared');
    expect(p).toContain('Open a change request');
    // The steps must still be numbered from 1 with no gaps.
    expect(p).toContain('1. ');
  });

  test('the steps are numbered contiguously from 1', () => {
    const p = buildSubprojectInstallPrompt(subject(), TARGET);
    const numbers = [...p.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1]));
    expect(numbers.length).toBeGreaterThan(5);
    expect(numbers).toEqual(numbers.map((_, i) => i + 1));
  });

  test('a manifest that will not serialize degrades to JSON instead of throwing', () => {
    const cyclic: Record<string, unknown> = { kortix_version: 2 };
    cyclic.self = cyclic;
    // Must not throw: a formatting problem can never block an install.
    expect(() => buildSubprojectInstallPrompt(subject({ manifest: cyclic }), TARGET)).not.toThrow();
  });
});

describe('buildSubprojectUninstallPrompt', () => {
  const subproject = {
    slug: 'seo-watch',
    title: 'SEO watch',
    repoOwner: 'acme',
    repoName: 'seo-subproject',
    owns: { agents: ['seo-writer'], triggers: ['seo-weekly'], skills: ['seo-audit'] },
  };

  test('lists what the subproject owns and removes triggers first', () => {
    const p = buildSubprojectUninstallPrompt(subproject, TARGET);
    expect(p).toContain('agents: seo-writer');
    expect(p).toContain('triggers: seo-weekly');
    expect(p).toContain('Remove the triggers it owns FIRST');
    expect(p).toContain('so nothing fires mid-uninstall');
  });

  test('trusts the `subproject:` stamp over `owns` on a mismatch, and reports it', () => {
    const p = buildSubprojectUninstallPrompt(subproject, TARGET);
    expect(p).toContain('subproject: seo-watch');
    expect(p).toContain('trust `subproject:` on the entry');
    expect(p).toContain('hand-edited');
  });

  test('never revokes a connected connector', () => {
    const p = buildSubprojectUninstallPrompt(subproject, TARGET);
    expect(p).toContain('Do not revoke anything');
  });

  test('keeps anything the project also uses on its own', () => {
    expect(buildSubprojectUninstallPrompt(subproject, TARGET)).toContain(
      'Leave anything this project also uses',
    );
  });

  test('removes the subprojects: entry and opens a CR', () => {
    const p = buildSubprojectUninstallPrompt(subproject, TARGET);
    expect(p).toContain('Remove the `subprojects:` entry');
    expect(p).toContain('open a change request');
    expect(p).toContain('Do not merge without my explicit approval');
  });

  test('an empty owns map tells the agent to verify rather than assume', () => {
    const p = buildSubprojectUninstallPrompt({ ...subproject, owns: {} }, TARGET);
    expect(p).toContain('lists nothing');
    expect(p).toContain('Confirm that by searching');
  });
});

describe('buildSubprojectInstallPrompt — an UPLOADED subproject', () => {
  const uploaded = () =>
    subject({
      sourceKind: 'upload',
      repoOwner: null,
      repoName: null,
      uploadName: 'seo-subproject.zip',
      gitRef: null,
      resolvedSha: null,
      manifestPath: 'kortix.yaml',
      files: [
        { path: 'kortix.yaml', content: 'kortix_version: 2\n' },
        {
          path: '.kortix/opencode/agents/seo-writer.md',
          content: '---\ndescription: X\n---\nBody.\n',
        },
        { path: '.kortix/opencode/skills/seo-audit/SKILL.md', content: '# SEO audit\n' },
      ],
    });

  test('says there is no repository, rather than implying one', () => {
    const p = buildSubprojectInstallPrompt(uploaded(), TARGET);
    expect(p).toContain('was UPLOADED as seo-subproject.zip');
    expect(p).toContain('there is no repository behind it');
    // The agent must not be sent hunting for a raw URL that cannot exist.
    expect(p).not.toContain('raw.githubusercontent.com');
  });

  test('embeds every file verbatim except the manifest, which is already shown', () => {
    const p = buildSubprojectInstallPrompt(uploaded(), TARGET);
    expect(p).toContain('--- .kortix/opencode/agents/seo-writer.md ---');
    expect(p).toContain('--- .kortix/opencode/skills/seo-audit/SKILL.md ---');
    expect(p).toContain('Body.');
    expect(p).toContain('# SEO audit');
    // Embedding kortix.yaml twice would waste context and invite the agent to
    // pick the wrong copy.
    expect(p).not.toContain('--- kortix.yaml ---');
    expect(p).toContain('These ARE the subproject');
  });

  test('points the copy steps at the embedded blocks, not at a URL', () => {
    const p = buildSubprojectInstallPrompt(uploaded(), TARGET);
    expect(p).toContain('the embedded `.kortix/opencode/agents/<name>.md` blocks above');
    expect(p).toContain('the embedded `.kortix/opencode/skills/<name>/` blocks above');
  });

  test('records the upload in `subprojects:` WITHOUT inventing a repo or sha', () => {
    const p = buildSubprojectInstallPrompt(uploaded(), TARGET);
    expect(p).toContain('uploaded archive: seo-subproject.zip');
    // The manifest schema requires `repo` to be `owner/repo`; an upload has
    // none, so the entry must not claim one.
    expect(p).not.toContain('    repo: seo-subproject.zip');
    expect(p).not.toContain('    sha:');
  });

  test('still ships triggers disabled and still opens a CR', () => {
    const p = buildSubprojectInstallPrompt(uploaded(), TARGET);
    expect(p).toContain('`enabled: false`');
    expect(p).toContain('Open a change request');
    expect(p).toContain('subproject: seo-watch');
  });

  test('an upload carrying only a manifest embeds nothing but still works', () => {
    const p = buildSubprojectInstallPrompt(
      { ...uploaded(), files: [{ path: 'kortix.yaml', content: 'kortix_version: 2\n' }] },
      TARGET,
    );
    expect(p).toContain('Its 0 files');
    expect(p).toContain('Open a change request');
  });
});

/**
 * The embed budget — the one place raising the archive cap to 5 MB could have
 * produced a SILENTLY broken subproject.
 *
 * An upload has no repository, so its files reach the agent only through the
 * prompt. Truncating that quietly is the worst possible failure: the agent
 * writes a partial subproject and reports success, and the person finds out when it
 * does not work. So the contract is that omitted files are NAMED and the agent
 * is told to stop.
 */
describe('upload embed budget', () => {
  const file = (path: string, bytes: number) => ({ path, content: 'x'.repeat(bytes) });

  function upload(files: Array<{ path: string; content: string }>): SubprojectInstallSubject {
    return subject({
      sourceKind: 'upload',
      repoOwner: null,
      repoName: null,
      uploadName: 'seo-watch.zip',
      files,
    });
  }

  test('subprojectExceedsEmbedBudget is measured on total content, not file count', () => {
    expect(subprojectExceedsEmbedBudget([file('a.md', 10)])).toBe(false);
    expect(subprojectExceedsEmbedBudget([file('a.md', SUBPROJECT_INSTALL_EMBED_BUDGET + 1)])).toBe(true);
    // Two files that individually fit but together do not.
    const half = Math.ceil(SUBPROJECT_INSTALL_EMBED_BUDGET / 2) + 1;
    expect(subprojectExceedsEmbedBudget([file('a.md', half), file('b.md', half)])).toBe(true);
  });

  test('a normal subproject is embedded whole, with no omission notice', () => {
    const prompt = buildSubprojectInstallPrompt(
      upload([file('.kortix/opencode/agents/seo-writer.md', 2_000), file('README.md', 500)]),
      null,
    );
    expect(prompt).toContain('.kortix/opencode/agents/seo-writer.md');
    expect(prompt).toContain('README.md');
    expect(prompt).not.toContain('NOT INCLUDED');
    expect(prompt).toContain('Its 2 files, verbatim');
  });

  test('over budget: the omitted files are NAMED and the agent is told to stop', () => {
    const prompt = buildSubprojectInstallPrompt(
      upload([file('small.md', 100), file('huge.md', SUBPROJECT_INSTALL_EMBED_BUDGET)]),
      null,
    );
    // The small file still arrives...
    expect(prompt).toContain('small.md');
    // ...and the big one is reported, not silently dropped.
    expect(prompt).toContain('NOT INCLUDED');
    expect(prompt).toContain('huge.md');
    expect(prompt).toContain('tell me exactly which files are missing');
    expect(prompt).toContain('Do not invent their contents');
    // The header must count what was EMBEDDED, or the agent is told it has
    // files it does not have.
    expect(prompt).toContain('Its 1 file, verbatim');
  });

  test('smallest first — one huge fixture never starves the real subproject content', () => {
    const prompt = buildSubprojectInstallPrompt(
      upload([
        file('huge-fixture.json', SUBPROJECT_INSTALL_EMBED_BUDGET - 100),
        file('agent.md', 200),
        file('skill.md', 200),
      ]),
      null,
    );
    // Both small files fit; the fixture is what gets dropped.
    expect(prompt).toContain('agent.md');
    expect(prompt).toContain('skill.md');
    expect(prompt).toContain('NOT INCLUDED');
    expect(prompt).toContain('huge-fixture.json');
  });

  test('the manifest is never double-embedded, budget or not', () => {
    const prompt = buildSubprojectInstallPrompt(
      upload([file('kortix.yaml', 50), file('agent.md', 50)]),
      null,
    );
    // `kortix.yaml` is rendered from the parsed manifest above; the file list
    // filters it out so it does not appear twice with possibly different text.
    expect(prompt).not.toContain('--- kortix.yaml ---');
  });

  test('an upload with no extra files still renders', () => {
    const prompt = buildSubprojectInstallPrompt(upload([]), null);
    expect(prompt).toContain('Its 0 files, verbatim');
    expect(prompt).not.toContain('NOT INCLUDED');
  });
});
