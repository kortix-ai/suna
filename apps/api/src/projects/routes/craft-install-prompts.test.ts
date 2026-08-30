/**
 * The craft install/uninstall prompts ARE the contract with the installing
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
  type CraftInstallSubject,
  buildCraftInstallPrompt,
  buildCraftUninstallPrompt,
  craftFetchRef,
  craftRawBase,
} from './craft-install-prompts';

const SHA = '9f3c1a7ecb4d21f0a8b3c5d7e9f1a2b3c4d5e6f7';

function subject(overrides: Partial<CraftInstallSubject> = {}): CraftInstallSubject {
  return {
    slug: 'seo-watch',
    title: 'SEO watch',
    description: 'Audits the site weekly and opens a change request.',
    repoOwner: 'acme',
    repoName: 'seo-craft',
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

describe('buildCraftInstallPrompt — provenance', () => {
  test('reads the craft at the pinned SHA, not at the branch', () => {
    const p = buildCraftInstallPrompt(subject(), TARGET);
    expect(p).toContain(SHA);
    expect(p).toContain(`https://raw.githubusercontent.com/acme/seo-craft/${SHA}`);
    // A branch would let the agent copy files that never matched the manifest
    // it was shown.
    expect(p).not.toContain('raw.githubusercontent.com/acme/seo-craft/main');
  });

  test('falls back to the branch only when no sha was recorded', () => {
    const craft = subject({ resolvedSha: null });
    expect(craftFetchRef(craft)).toBe('main');
    expect(craftRawBase(craft)).toBe('https://raw.githubusercontent.com/acme/seo-craft/main');
  });

  test('falls back to HEAD when there is neither a sha nor a ref', () => {
    expect(craftFetchRef(subject({ resolvedSha: null, gitRef: null }))).toBe('HEAD');
  });

  test("embeds BOTH manifests — the craft's and the target's", () => {
    const p = buildCraftInstallPrompt(subject(), TARGET);
    expect(p).toContain('default_agent: seo-writer'); // the craft's
    expect(p).toContain('default_agent: kortix'); // the target's
    expect(p).toContain('what you must not break');
  });

  test('a project with no manifest yet is stated, not hidden', () => {
    const p = buildCraftInstallPrompt(subject(), null);
    expect(p).toContain('no manifest yet');
  });

  test('tells the agent everything it needs is in the prompt', () => {
    expect(buildCraftInstallPrompt(subject(), TARGET)).toContain('do not search the web');
  });
});

describe('buildCraftInstallPrompt — the ownership record', () => {
  test('spells out the `crafts:` entry with repo, ref and sha', () => {
    const p = buildCraftInstallPrompt(subject(), TARGET);
    expect(p).toContain('crafts:');
    expect(p).toContain('- slug: seo-watch');
    expect(p).toContain('repo: acme/seo-craft');
    expect(p).toContain('ref: main');
    expect(p).toContain(`sha: ${SHA}`);
  });

  test('omits ref and sha when the craft has none', () => {
    const p = buildCraftInstallPrompt(subject({ gitRef: null, resolvedSha: null }), TARGET);
    expect(p).not.toContain('    ref:');
    expect(p).not.toContain('    sha:');
    expect(p).toContain('repo: acme/seo-craft');
  });

  test('requires `owns` to reflect what ACTUALLY landed, after renames', () => {
    const p = buildCraftInstallPrompt(subject(), TARGET);
    expect(p).toContain('owns:');
    expect(p).toContain('after any rename');
    expect(p).toContain('ACTUALLY landed');
  });

  test('demands the craft: stamp and says why the trigger one matters', () => {
    const p = buildCraftInstallPrompt(subject(), TARGET);
    expect(p).toContain('craft: seo-watch');
    // If the agent omits it the trigger still fires, so the prompt has to make
    // the consequence explicit or it reads as optional bookkeeping.
    expect(p).toContain("never appear in the craft's run history");
  });
});

describe('buildCraftInstallPrompt — the merge must not break the project', () => {
  test('never changes default_agent', () => {
    const p = buildCraftInstallPrompt(subject(), TARGET);
    expect(p).toContain('never change `default_agent`');
  });

  test('renames a colliding agent rather than overwriting', () => {
    const p = buildCraftInstallPrompt(subject(), TARGET);
    expect(p).toContain('Rename on collision');
    expect(p).toContain('Never remove or overwrite an existing agent');
  });

  test('keeps an existing connector rather than redefining it', () => {
    // The existing one may already hold credentials.
    const p = buildCraftInstallPrompt(subject(), TARGET);
    expect(p).toContain('KEEP the existing one');
  });

  test('validates before committing', () => {
    expect(buildCraftInstallPrompt(subject(), TARGET)).toContain('kortix validate');
  });

  test('opens a change request and never pushes to the default branch', () => {
    const p = buildCraftInstallPrompt(subject(), TARGET);
    expect(p).toContain('Open a change request');
    expect(p).toContain('do not push directly to the default branch');
    expect(p).toContain('Do not merge without my explicit approval');
  });
});

describe('buildCraftInstallPrompt — nothing starts firing on install', () => {
  test('every trigger ships disabled', () => {
    const p = buildCraftInstallPrompt(subject(), TARGET);
    expect(p).toContain('`enabled: false`');
    expect(p).toContain('starts firing because I said go');
  });

  test('enabling comes after the merge and only once requirements resolve', () => {
    const p = buildCraftInstallPrompt(subject(), TARGET);
    expect(p).toContain('Only after the merge');
    expect(p).toContain('never while something it needs is still missing');
  });

  test('a craft with no triggers gets no enable step at all', () => {
    const p = buildCraftInstallPrompt(subject({ triggers: [] }), TARGET);
    expect(p).not.toContain('enabled: false');
    expect(p).toContain('what the craft can now do');
  });
});

describe('buildCraftInstallPrompt — credentials', () => {
  test('names the secrets and connectors, and forbids pasting a raw key', () => {
    const p = buildCraftInstallPrompt(subject(), TARGET);
    expect(p).toContain('SEARCH_CONSOLE_KEY');
    expect(p).toContain('search-console');
    expect(p).toContain('request_secret');
    expect(p).toContain('never ask me to paste a raw key');
  });

  test('tells the agent not to re-ask for something already connected', () => {
    expect(buildCraftInstallPrompt(subject(), TARGET)).toContain('already connected');
  });

  test('a craft needing nothing gets no credential walkthrough', () => {
    const p = buildCraftInstallPrompt(subject({ envRequired: [], connectors: [] }), TARGET);
    expect(p).not.toContain('request_secret');
  });
});

describe('buildCraftInstallPrompt — only the steps that apply', () => {
  test('a craft with no skills gets no skill-copy step', () => {
    const p = buildCraftInstallPrompt(subject({ skills: [] }), TARGET);
    expect(p).not.toContain('opencode/skills/<name>/');
  });

  test('a craft with no agents gets no agent-copy step', () => {
    const p = buildCraftInstallPrompt(subject({ agents: [] }), TARGET);
    expect(p).not.toContain('agents/<name>.md');
  });

  test('a craft that declares nothing still produces a coherent prompt', () => {
    const p = buildCraftInstallPrompt(
      subject({ agents: [], triggers: [], connectors: [], skills: [], envRequired: [] }),
      TARGET,
    );
    expect(p).toContain('nothing declared');
    expect(p).toContain('Open a change request');
    // The steps must still be numbered from 1 with no gaps.
    expect(p).toContain('1. ');
  });

  test('the steps are numbered contiguously from 1', () => {
    const p = buildCraftInstallPrompt(subject(), TARGET);
    const numbers = [...p.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1]));
    expect(numbers.length).toBeGreaterThan(5);
    expect(numbers).toEqual(numbers.map((_, i) => i + 1));
  });

  test('a manifest that will not serialize degrades to JSON instead of throwing', () => {
    const cyclic: Record<string, unknown> = { kortix_version: 2 };
    cyclic.self = cyclic;
    // Must not throw: a formatting problem can never block an install.
    expect(() => buildCraftInstallPrompt(subject({ manifest: cyclic }), TARGET)).not.toThrow();
  });
});

describe('buildCraftUninstallPrompt', () => {
  const craft = {
    slug: 'seo-watch',
    title: 'SEO watch',
    repoOwner: 'acme',
    repoName: 'seo-craft',
    owns: { agents: ['seo-writer'], triggers: ['seo-weekly'], skills: ['seo-audit'] },
  };

  test('lists what the craft owns and removes triggers first', () => {
    const p = buildCraftUninstallPrompt(craft, TARGET);
    expect(p).toContain('agents: seo-writer');
    expect(p).toContain('triggers: seo-weekly');
    expect(p).toContain('Remove the triggers it owns FIRST');
    expect(p).toContain('so nothing fires mid-uninstall');
  });

  test('trusts the `craft:` stamp over `owns` on a mismatch, and reports it', () => {
    const p = buildCraftUninstallPrompt(craft, TARGET);
    expect(p).toContain('craft: seo-watch');
    expect(p).toContain('trust `craft:` on the entry');
    expect(p).toContain('hand-edited');
  });

  test('never revokes a connected connector', () => {
    const p = buildCraftUninstallPrompt(craft, TARGET);
    expect(p).toContain('Do not revoke anything');
  });

  test('keeps anything the project also uses on its own', () => {
    expect(buildCraftUninstallPrompt(craft, TARGET)).toContain(
      'Leave anything this project also uses',
    );
  });

  test('removes the crafts: entry and opens a CR', () => {
    const p = buildCraftUninstallPrompt(craft, TARGET);
    expect(p).toContain('Remove the `crafts:` entry');
    expect(p).toContain('open a change request');
    expect(p).toContain('Do not merge without my explicit approval');
  });

  test('an empty owns map tells the agent to verify rather than assume', () => {
    const p = buildCraftUninstallPrompt({ ...craft, owns: {} }, TARGET);
    expect(p).toContain('lists nothing');
    expect(p).toContain('Confirm that by searching');
  });
});
