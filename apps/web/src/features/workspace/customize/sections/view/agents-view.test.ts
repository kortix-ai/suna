import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Source-text contract for the simplified Agents screen.
 *
 * AgentsView is a full-page composition of live queries (project detail,
 * access, model defaults, resource grants) so it cannot be rendered in a bun
 * test without standing up a QueryClient and the SDK. The rules that the
 * simplification has to hold — one shell, one search, one Advanced disclosure,
 * the default-agent picker in the header, nothing deleted — are all structural,
 * so assert them against the source the way the neighbouring guards do
 * (chunk22256-guard.test.ts, connectors-view.slack-channel.test.ts).
 */

const AGENTS_VIEW = join(import.meta.dir, 'agents-view.tsx');
const source = readFileSync(AGENTS_VIEW, 'utf8');

/** The `<ProjectSectionPage …>` opening tag, up to its first `>`. */
function openingTag(): string {
  const match = source.match(/<ProjectSectionPage\b[\s\S]*?>/);
  if (!match) throw new Error('agents-view no longer renders <ProjectSectionPage>');
  return match[0];
}

/** The JSX passed to a named prop, read by bracket-matching `prop={ … }`. */
function propValue(prop: string): string {
  const start = source.indexOf(`${prop}={`);
  if (start === -1) throw new Error(`agents-view has no ${prop}={…} prop`);
  let depth = 0;
  for (let i = start + prop.length + 1; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces reading ${prop}={…}`);
}

describe('shell', () => {
  test('renders inside ProjectSectionPage, not the old Customize wrapper', () => {
    expect(source).toContain('ProjectSectionPage');
    expect(source).not.toContain('CustomizeSectionWrapper');
    // page-header.tsx is the marketing hero — wrong register for a section.
    expect(source).not.toContain('components/ui/page-header');
  });

  test('no longer delegates the whole screen to the generic ConfigEntityView', () => {
    expect(source).not.toContain('ConfigEntityView');
    expect(source).not.toContain('renderContext');
  });

  test('titles the page Agents with exactly one line of description', () => {
    const tag = openingTag();
    expect(tag).toContain('title="Agents"');
    const description = tag.match(/\bdescription="([^"]*)"/);
    expect(description).not.toBeNull();
    const value = description?.[1] ?? '';
    expect(value.length).toBeGreaterThan(0);
    expect(value.length).toBeLessThanOrEqual(90);
    expect(value).not.toContain('\n');
  });

  test('search is declared once, on the page header', () => {
    expect(source).toContain("placeholder: 'Search agents'");
    expect(source.match(/placeholder: 'Search agents'/g)).toHaveLength(1);
  });

  test('drives every branch of the shared state ladder', () => {
    for (const branch of ['loading', 'forbidden', 'error', 'empty', 'no-results', 'ready']) {
      expect(source).toContain(`'${branch}'`);
    }
  });
});

describe('header cluster', () => {
  const action = propValue('action');

  test('"New agent" is the single primary action', () => {
    expect(source).toContain('New agent');
    expect(action).toContain('newAgentButton');
  });

  test('the default-agent Select lives in the header, not in the body', () => {
    expect(action).toContain('DefaultAgentSelector');
    // If it were still in the body it would sit inside the children block,
    // below <ProjectSectionPage …> — assert it is above the list instead.
    expect(source.indexOf('<DefaultAgentSelector')).toBeLessThan(source.indexOf('<AgentList'));
  });

  test('the default-agent control is a labelled Select', () => {
    expect(source).toContain('aria-label="Default agent"');
    expect(source).toContain('<SelectTrigger');
    expect(source).toContain('>Default<');
  });

  test('Marketplace stays reachable from the header', () => {
    expect(action).toContain('marketplaceLink');
  });

  test('Marketplace navigates instead of poking the overlay store', () => {
    // MarketplaceSectionButton's whole onClick is setSection('marketplace'),
    // which never sets `open` — on this route it did nothing visible AND
    // silently repointed where the overlay would next open.
    // The prose explaining why still names the component, so assert on the
    // rendered element rather than the bare word.
    expect(source).not.toContain('<MarketplaceSectionButton');
    expect(source).toContain('/marketplace`');
  });
});

describe('detail pane', () => {
  test('keeps the master-detail split: list left, detail right', () => {
    expect(source).toContain('<AgentList');
    expect(source).toContain('<AgentDetail');
    expect(source.indexOf('<AgentList')).toBeLessThan(source.indexOf('<AgentDetail'));
  });

  test('AgentModel stays visible — outside the Advanced disclosure', () => {
    expect(source.indexOf('<AgentModel')).toBeLessThan(source.indexOf('<AgentAdvanced>'));
  });

  test('assignments and access scope sit behind the ONE Advanced disclosure', () => {
    const start = source.indexOf('<AgentAdvanced>');
    const end = source.indexOf('</AgentAdvanced>');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const advanced = source.slice(start, end);
    expect(advanced).toContain('<AgentAssignments');
    expect(advanced).toContain('<AgentScope');
    expect(advanced).toContain('<AgentConfigEditor');
  });

  test('there is exactly one Advanced disclosure on the screen', () => {
    expect(source.match(/<AgentAdvanced>/g)).toHaveLength(1);
  });
});

describe('nothing was removed', () => {
  test('every capability the old screen exposed is still mounted', () => {
    for (const capability of [
      'DefaultAgentSelector',
      'AgentAssignments',
      'AgentConfigEditor',
      'AgentModel',
      'AgentScope',
      'MarketplaceSectionButton',
      'updateProjectDefaultAgent',
    ]) {
      expect(source).toContain(capability);
    }
  });

  test('the detail meta badges survive the move', () => {
    for (const badge of ['formatMode', 'kortix.yaml', 'kortix.toml', 'OpenCode', 'Disabled']) {
      expect(source).toContain(badge);
    }
  });

  test('read-only viewers still lose only the mutating controls', () => {
    expect(source).toContain('PROJECT_AGENT_WRITE');
    expect(source).toContain('canWrite');
  });
});

describe('chunk-22256 guards survive the rewrite', () => {
  // Mirrors customize/shared/chunk22256-guard.test.ts, which reads this same
  // file by relative path. Duplicated deliberately: a co-located copy fails
  // first and points at the file that broke.
  test('config.agents is coerced before .filter', () => {
    expect(source).not.toContain('config.agents.filter(');
    expect(source).toContain('toArray(config.agents).filter(');
  });

  test('config.skills is coerced before .map', () => {
    expect(source).not.toContain('config.skills.map(');
    expect(source).toContain('toArray(config.skills).map(');
  });
});

describe('design system', () => {
  test('uses none of the banned primitives', () => {
    for (const banned of [
      'components/ui/list',
      'SectionCard',
      'Loader2',
      'animate-spin',
      'from "@/components/ui/tooltip"',
      "from '@/components/ui/tooltip'",
    ]) {
      expect(source).not.toContain(banned);
    }
  });

  test('tooltips go through Hint and spinners through Loading', () => {
    expect(source).toContain("import Hint from '@/components/ui/hint'");
    expect(source).toContain("import Loading from '@/components/ui/loading'");
  });
});
