import { describe, expect, it } from 'bun:test';
import type { CatalogApp } from '../../connectors/pipedream-search';
import {
  AGENTS_SKILLS_CAP,
  AVAILABLE_CONNECTORS_CAP,
  BUNDLE_CAP,
  FILE_PATHS_MAX_ENTRIES,
  MAX_AVAILABLE_CONNECTORS,
  MEMORY_CAP,
  README_CAP,
  renderSignalBundle,
  selectAvailableConnectors,
  SESSIONS_CAP,
  type SignalSources,
} from './signals';

function emptySources(): SignalSources {
  return {
    onboarding: null,
    memory: [],
    readme: null,
    filePaths: [],
    sessions: [],
    agents: [],
    skills: [],
    connectors: [],
    availableConnectors: [],
  };
}

function catalogApp(over: Partial<CatalogApp> = {}): CatalogApp {
  return {
    slug: 'slack',
    name: 'Slack',
    description: null,
    imgSrc: null,
    authType: null,
    categories: [],
    hasActions: true,
    hasTriggers: false,
    featuredWeight: 0,
    ...over,
  };
}

describe('renderSignalBundle', () => {
  it('returns empty text and hasSignals: false for fully empty sources', () => {
    const result = renderSignalBundle(emptySources());
    expect(result.text).toBe('');
    expect(result.hasSignals).toBe(false);
  });

  it('hasSignals stays false when onboarding is an empty object', () => {
    const result = renderSignalBundle({ ...emptySources(), onboarding: {} });
    expect(result.hasSignals).toBe(false);
  });

  it('onboarding alone counts as signals even when every other section is empty', () => {
    const result = renderSignalBundle({
      ...emptySources(),
      onboarding: { use_case: 'engineering' },
    });
    expect(result.hasSignals).toBe(true);
    expect(result.text).toContain('## Onboarding');
    expect(result.text).toContain('engineering');
  });

  it('a single non-onboarding section also counts as signals', () => {
    const result = renderSignalBundle({ ...emptySources(), connectors: ['Slack'] });
    expect(result.hasSignals).toBe(true);
    expect(result.text).toContain('## Connectors');
    expect(result.text).toContain('Slack');
  });

  it('labels the memory section and caps its body to MEMORY_CAP chars', () => {
    const big = 'z'.repeat(MEMORY_CAP + 500);
    const result = renderSignalBundle({
      ...emptySources(),
      memory: [{ path: '.kortix/memory/MEMORY.md', content: big }],
    });
    const heading = '## Memory\n';
    expect(result.text).toContain(heading);
    const sectionStart = result.text.indexOf(heading);
    const body = result.text.slice(sectionStart + heading.length);
    expect(body.length).toBe(MEMORY_CAP);
  });

  it('skips memory entries with only whitespace content for hasSignals purposes', () => {
    const result = renderSignalBundle({
      ...emptySources(),
      memory: [{ path: '.kortix/memory/MEMORY.md', content: '   \n  ' }],
    });
    expect(result.hasSignals).toBe(false);
  });

  it('labels the README section and caps it to README_CAP chars', () => {
    const big = 'r'.repeat(README_CAP + 200);
    const result = renderSignalBundle({ ...emptySources(), readme: big });
    expect(result.text).toContain('## README');
    const rCount = (result.text.match(/r/g) ?? []).length;
    expect(rCount).toBe(README_CAP);
  });

  it('labels the files section and caps entries to FILE_PATHS_MAX_ENTRIES', () => {
    const paths = Array.from({ length: FILE_PATHS_MAX_ENTRIES + 50 }, (_, i) => `src/file-${i}.ts`);
    const result = renderSignalBundle({ ...emptySources(), filePaths: paths });
    expect(result.text).toContain('## Files');
    expect(result.text).toContain('src/file-0.ts');
    expect(result.text).not.toContain(`src/file-${FILE_PATHS_MAX_ENTRIES}.ts`);
    const lineCount = result.text
      .split('\n')
      .filter((line) => line.startsWith('src/file-')).length;
    expect(lineCount).toBe(FILE_PATHS_MAX_ENTRIES);
  });

  it('labels the recent sessions section and caps it to SESSIONS_CAP chars', () => {
    const sessions = Array.from({ length: 10 }, (_, i) => ({
      title: `Session ${i}`,
      initialPrompt: 'p'.repeat(300),
    }));
    const result = renderSignalBundle({ ...emptySources(), sessions });
    expect(result.text).toContain('## Recent sessions');
    const sectionStart = result.text.indexOf('## Recent sessions');
    const nextSection = result.text.indexOf('\n\n## ', sectionStart + 1);
    const section =
      nextSection === -1 ? result.text.slice(sectionStart) : result.text.slice(sectionStart, nextSection);
    expect(section.length).toBeLessThanOrEqual(SESSIONS_CAP + '## Recent sessions\n'.length);
  });

  it('ignores sessions with neither title nor initialPrompt for hasSignals', () => {
    const result = renderSignalBundle({
      ...emptySources(),
      sessions: [{ title: null, initialPrompt: null }],
    });
    expect(result.hasSignals).toBe(false);
  });

  it('labels agents and skills sections when both are present', () => {
    const result = renderSignalBundle({
      ...emptySources(),
      agents: [{ name: 'reviewer', description: 'reviews code' }],
      skills: [{ name: 'deploy', description: 'deploys the app' }],
    });
    expect(result.text).toContain('## Agents');
    expect(result.text).toContain('## Skills');
  });

  it('caps combined agents+skills text to AGENTS_SKILLS_CAP even when skills get truncated away', () => {
    const agents = Array.from({ length: 30 }, (_, i) => ({
      name: `agent-${i}`,
      description: 'd'.repeat(50),
    }));
    const skills = Array.from({ length: 30 }, (_, i) => ({
      name: `skill-${i}`,
      description: 'd'.repeat(50),
    }));
    const result = renderSignalBundle({ ...emptySources(), agents, skills });
    expect(result.text).toContain('## Agents');
    const sectionStart = result.text.indexOf('## Agents');
    const section = result.text.slice(sectionStart);
    expect(section.length).toBeLessThanOrEqual(AGENTS_SKILLS_CAP);
  });

  it('caps the whole bundle to BUNDLE_CAP chars', () => {
    const result = renderSignalBundle({
      onboarding: { use_case: 'engineering', company_size: '11-50' },
      memory: [{ path: '.kortix/memory/MEMORY.md', content: 'm'.repeat(MEMORY_CAP) }],
      readme: 'r'.repeat(README_CAP),
      filePaths: Array.from({ length: FILE_PATHS_MAX_ENTRIES }, (_, i) => `src/very-long-file-name-${i}.ts`),
      sessions: Array.from({ length: 10 }, (_, i) => ({
        title: `Session ${i}`,
        initialPrompt: 'p'.repeat(300),
      })),
      agents: Array.from({ length: 10 }, (_, i) => ({ name: `agent-${i}`, description: 'd'.repeat(50) })),
      skills: Array.from({ length: 10 }, (_, i) => ({ name: `skill-${i}`, description: 'd'.repeat(50) })),
      connectors: ['Slack', 'Gmail', 'Linear'],
      availableConnectors: Array.from({ length: 20 }, (_, i) => ({ slug: `app-${i}`, name: `App ${i}` })),
    });
    expect(result.text.length).toBeLessThanOrEqual(BUNDLE_CAP);
    expect(result.hasSignals).toBe(true);
  });

  it('labels the agents section when only agents are present', () => {
    const result = renderSignalBundle({
      ...emptySources(),
      agents: [{ name: 'reviewer', description: 'reviews code' }],
    });
    expect(result.text).toContain('## Agents');
    expect(result.text).not.toContain('## Skills');
    expect(result.hasSignals).toBe(true);
  });

  it('labels the skills section when only skills are present', () => {
    const result = renderSignalBundle({
      ...emptySources(),
      skills: [{ name: 'deploy', description: 'deploys the app' }],
    });
    expect(result.text).toContain('## Skills');
    expect(result.text).not.toContain('## Agents');
    expect(result.hasSignals).toBe(true);
  });

  it('renders agents/skills without a description', () => {
    const result = renderSignalBundle({
      ...emptySources(),
      agents: [{ name: 'reviewer' }],
    });
    expect(result.text).toContain('reviewer');
  });

  it('labels the available connectors section as "name (slug)" pairs', () => {
    const result = renderSignalBundle({
      ...emptySources(),
      availableConnectors: [
        { slug: 'slack', name: 'Slack' },
        { slug: 'notion', name: 'Notion' },
      ],
    });
    expect(result.text).toContain('## Available connectors');
    expect(result.text).toContain('Slack (slack)');
    expect(result.text).toContain('Notion (notion)');
  });

  it('caps the available connectors section to AVAILABLE_CONNECTORS_CAP chars', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      slug: `app-${i}`,
      name: `App Number ${i} With A Fairly Long Display Name`,
    }));
    const result = renderSignalBundle({ ...emptySources(), availableConnectors: many });
    const heading = '## Available connectors\n';
    const sectionStart = result.text.indexOf(heading);
    expect(sectionStart).not.toBe(-1);
    const body = result.text.slice(sectionStart + heading.length);
    expect(body.length).toBeLessThanOrEqual(AVAILABLE_CONNECTORS_CAP);
  });

  it('omits the available connectors section entirely when empty', () => {
    const result = renderSignalBundle(emptySources());
    expect(result.text).not.toContain('## Available connectors');
  });

  it('availableConnectors alone does NOT make hasSignals true — it is an offer list, not a workspace signal', () => {
    const result = renderSignalBundle({
      ...emptySources(),
      availableConnectors: [{ slug: 'slack', name: 'Slack' }],
    });
    expect(result.hasSignals).toBe(false);
    expect(result.text).toContain('## Available connectors');
  });

  it('a real signal alongside availableConnectors still reports hasSignals true', () => {
    const result = renderSignalBundle({
      ...emptySources(),
      connectors: ['Gmail'],
      availableConnectors: [{ slug: 'slack', name: 'Slack' }],
    });
    expect(result.hasSignals).toBe(true);
  });
});

describe('selectAvailableConnectors', () => {
  it('returns [] when the catalogue snapshot is null (fail-open while warming)', () => {
    expect(selectAvailableConnectors(null, [])).toEqual([]);
  });

  it('returns [] for an empty catalogue', () => {
    expect(selectAvailableConnectors([], [])).toEqual([]);
  });

  it('excludes apps whose name already appears among connected connector names', () => {
    const apps = [catalogApp({ slug: 'slack', name: 'Slack' }), catalogApp({ slug: 'notion', name: 'Notion' })];
    const result = selectAvailableConnectors(apps, ['Slack']);
    expect(result).toEqual([{ slug: 'notion', name: 'Notion' }]);
  });

  it('excludes connected names case-insensitively', () => {
    const apps = [catalogApp({ slug: 'slack', name: 'Slack' })];
    const result = selectAvailableConnectors(apps, ['slack']);
    expect(result).toEqual([]);
  });

  it('orders by featuredWeight descending, then name', () => {
    const apps = [
      catalogApp({ slug: 'zeta', name: 'Zeta', featuredWeight: 0 }),
      catalogApp({ slug: 'alpha', name: 'Alpha', featuredWeight: 5 }),
      catalogApp({ slug: 'beta', name: 'Beta', featuredWeight: 0 }),
    ];
    const result = selectAvailableConnectors(apps, []);
    expect(result.map((c) => c.slug)).toEqual(['alpha', 'beta', 'zeta']);
  });

  it('caps at MAX_AVAILABLE_CONNECTORS entries', () => {
    const apps = Array.from({ length: MAX_AVAILABLE_CONNECTORS + 10 }, (_, i) =>
      catalogApp({ slug: `app-${i}`, name: `App ${i}` }),
    );
    const result = selectAvailableConnectors(apps, []);
    expect(result).toHaveLength(MAX_AVAILABLE_CONNECTORS);
  });

  it('maps only slug and name — no extra fields leak through', () => {
    const apps = [catalogApp({ slug: 'slack', name: 'Slack', imgSrc: 'https://example.test/slack.png' })];
    const result = selectAvailableConnectors(apps, []);
    expect(result).toEqual([{ slug: 'slack', name: 'Slack' }]);
  });
});
