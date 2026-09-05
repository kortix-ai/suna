/**
 * The install prompt IS the contract with the installing agent. There is no
 * deterministic merge behind it, so anything the prompt fails to say is a thing
 * the install will get wrong — silently, and only on some projects.
 *
 * These tests pin the instructions that are load-bearing rather than the
 * wording around them: the pinned ref, triggers shipping disabled,
 * `default_agent` being off-limits, rename-on-collision, one change request,
 * and removal by revert.
 */
import { describe, expect, test } from 'bun:test';
import type { MarketplaceCatalogEntry } from '../../marketplace/templates';
import {
  buildMarketplaceInstallPrompt,
  marketplaceFetchRef,
  marketplaceRawBase,
} from './marketplace-install-prompt';

const SHA = '9f3c1a7ecb4d21f0a8b3c5d7e9f1a2b3c4d5e6f7';

function template(overrides: Partial<MarketplaceCatalogEntry> = {}): MarketplaceCatalogEntry {
  return {
    slug: 'seo-watch',
    title: 'SEO watch',
    description: 'Audits the site weekly and opens a change request.',
    repo: 'acme/seo-template',
    repo_owner: 'acme',
    repo_name: 'seo-template',
    git_ref: 'main',
    resolved_sha: SHA,
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
    agents: [{ name: 'seo-writer', description: null }],
    triggers: [
      {
        slug: 'seo-weekly',
        name: 'Weekly SEO',
        type: 'cron',
        cron: '0 0 9 * * 1',
        agent: 'seo-writer',
        enabled: true,
      },
    ],
    connectors: [{ slug: 'search-console', provider: 'composio', app: 'google_search_console' }],
    skills: ['seo-audit'],
    env_required: ['SEARCH_CONSOLE_KEY'],
    ...overrides,
  };
}

const TARGET = `kortix_version: 2
default_agent: kortix
agents:
  kortix:
    connectors: all
`;

describe('buildMarketplaceInstallPrompt — provenance', () => {
  test('reads the template at the pinned SHA, not at the branch', () => {
    const p = buildMarketplaceInstallPrompt(template(), TARGET);
    expect(p).toContain(SHA);
    expect(p).toContain(`https://raw.githubusercontent.com/acme/seo-template/${SHA}`);
    // A branch would let the agent copy files that never matched the manifest
    // it was shown.
    expect(p).not.toContain('raw.githubusercontent.com/acme/seo-template/main');
  });

  test('falls back to the branch only when no sha was recorded', () => {
    const t = template({ resolved_sha: '' });
    expect(marketplaceFetchRef(t)).toBe('main');
    expect(marketplaceRawBase(t)).toBe('https://raw.githubusercontent.com/acme/seo-template/main');
  });

  test('falls back to HEAD when there is neither a sha nor a ref', () => {
    expect(marketplaceFetchRef(template({ resolved_sha: '', git_ref: null }))).toBe('HEAD');
  });

  test("embeds BOTH manifests — the template's and the target's", () => {
    const p = buildMarketplaceInstallPrompt(template(), TARGET);
    expect(p).toContain('default_agent: seo-writer'); // the template's
    expect(p).toContain('default_agent: kortix'); // the target's
    expect(p).toContain('what you must not break');
  });

  test('a project with no manifest yet is stated, not hidden', () => {
    expect(buildMarketplaceInstallPrompt(template(), null)).toContain('no manifest yet');
  });

  test('tells the agent everything it needs is in the prompt', () => {
    expect(buildMarketplaceInstallPrompt(template(), TARGET)).toContain('do not search the web');
  });
});

describe('buildMarketplaceInstallPrompt — the merge must not break the project', () => {
  test('never changes default_agent', () => {
    expect(buildMarketplaceInstallPrompt(template(), TARGET)).toContain(
      'never change `default_agent`',
    );
  });

  test('renames a colliding agent rather than overwriting', () => {
    const p = buildMarketplaceInstallPrompt(template(), TARGET);
    expect(p).toContain('Rename on collision');
    expect(p).toContain('Never remove or overwrite an existing agent');
  });

  test('keeps an existing connector rather than redefining it', () => {
    // The existing one may already hold credentials.
    expect(buildMarketplaceInstallPrompt(template(), TARGET)).toContain('KEEP the existing one');
  });

  test('validates before committing', () => {
    expect(buildMarketplaceInstallPrompt(template(), TARGET)).toContain('kortix validate');
  });

  test('opens ONE change request, never pushes to the default branch, and names revert as the uninstall', () => {
    const p = buildMarketplaceInstallPrompt(template(), TARGET);
    expect(p).toContain('Open a change request');
    expect(p).toContain('do not push directly to the default branch');
    expect(p).toContain('Do not merge without my explicit approval');
    // No installed-state record exists anywhere, so the one commit IS the
    // record. The prompt has to say so or the agent may split the install.
    expect(p).toContain('ONE change request');
    expect(p).toContain('revert that change request');
  });

  test('never asks for an ownership record — nothing reads one', () => {
    const p = buildMarketplaceInstallPrompt(template(), TARGET);
    expect(p).not.toContain('subprojects:');
    expect(p).not.toContain('owns:');
    expect(p).not.toContain('template: seo-watch');
  });
});

describe('buildMarketplaceInstallPrompt — nothing starts firing on install', () => {
  test('every trigger ships disabled', () => {
    const p = buildMarketplaceInstallPrompt(template(), TARGET);
    expect(p).toContain('`enabled: false`');
    expect(p).toContain('starts firing because I said go');
  });

  test('enabling comes after the merge and only once requirements resolve', () => {
    const p = buildMarketplaceInstallPrompt(template(), TARGET);
    expect(p).toContain('Only after the merge');
    expect(p).toContain('never while something it needs is still missing');
  });

  test('a template with no triggers gets no enable step at all', () => {
    const p = buildMarketplaceInstallPrompt(template({ triggers: [] }), TARGET);
    expect(p).not.toContain('enabled: false');
    expect(p).toContain('what the template can now do');
  });
});

describe('buildMarketplaceInstallPrompt — credentials', () => {
  test('names the secrets and connectors, and forbids pasting a raw key', () => {
    const p = buildMarketplaceInstallPrompt(template(), TARGET);
    expect(p).toContain('SEARCH_CONSOLE_KEY');
    expect(p).toContain('search-console');
    expect(p).toContain('request_secret');
    expect(p).toContain('never ask me to paste a raw key');
  });

  test('tells the agent not to re-ask for something already connected', () => {
    expect(buildMarketplaceInstallPrompt(template(), TARGET)).toContain('already connected');
  });

  test('a template needing nothing gets no credential walkthrough', () => {
    const p = buildMarketplaceInstallPrompt(template({ env_required: [], connectors: [] }), TARGET);
    expect(p).not.toContain('request_secret');
  });
});

describe('buildMarketplaceInstallPrompt — only the steps that apply', () => {
  test('a template with no skills gets no skill-copy step', () => {
    expect(buildMarketplaceInstallPrompt(template({ skills: [] }), TARGET)).not.toContain(
      'opencode/skills/<name>/',
    );
  });

  test('a template with no agents gets no agent-copy step', () => {
    expect(buildMarketplaceInstallPrompt(template({ agents: [] }), TARGET)).not.toContain(
      'agents/<name>.md',
    );
  });

  test('a template that declares nothing still produces a coherent prompt', () => {
    const p = buildMarketplaceInstallPrompt(
      template({ agents: [], triggers: [], connectors: [], skills: [], env_required: [] }),
      TARGET,
    );
    expect(p).toContain('nothing declared');
    expect(p).toContain('Open a change request');
    expect(p).toContain('1. ');
  });

  test('the steps are numbered contiguously from 1', () => {
    const p = buildMarketplaceInstallPrompt(template(), TARGET);
    const numbers = [...p.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1]));
    expect(numbers.length).toBeGreaterThan(5);
    expect(numbers).toEqual(numbers.map((_, i) => i + 1));
  });

  test('a manifest that will not serialize degrades to JSON instead of throwing', () => {
    const cyclic: Record<string, unknown> = { kortix_version: 2 };
    cyclic.self = cyclic;
    // Must not throw: a formatting problem can never block an install.
    expect(() =>
      buildMarketplaceInstallPrompt(template({ manifest: cyclic }), TARGET),
    ).not.toThrow();
  });
});
