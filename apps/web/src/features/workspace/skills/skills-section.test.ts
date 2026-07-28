import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Source-text contract for the Skills screen.
 *
 * The point of the rebuild is structural — one shell, one modal, one restored
 * tab — so the assertions are about which primitives the file reaches for.
 */

const HERE = import.meta.dir;
const VIEW_DIR = join(HERE, '..', 'customize', 'sections', 'view');
const ROUTE = join(
  HERE,
  '..',
  '..',
  '..',
  'app',
  '(app)',
  'projects',
  '[id]',
  'skills',
  'page.tsx',
);

const section = readFileSync(join(HERE, 'skills-section.tsx'), 'utf8');
const detail = readFileSync(join(HERE, 'skill-detail.tsx'), 'utf8');
const card = readFileSync(join(HERE, 'skill-card.tsx'), 'utf8');
const panes = readFileSync(join(HERE, 'skill-detail-panes.tsx'), 'utf8');
const skillsView = readFileSync(join(VIEW_DIR, 'skills-view.tsx'), 'utf8');
const commandsView = readFileSync(join(VIEW_DIR, 'commands-view.tsx'), 'utf8');
const route = readFileSync(ROUTE, 'utf8');

const ALL = [section, detail, card, panes].join('\n');

describe('the shared section shell', () => {
  test('the screen is a ProjectSectionPage', () => {
    expect(section).toContain('<ProjectSectionPage');
    expect(section).toContain('project-section/project-section-page');
  });

  test('it does not fall back to the old customize wrapper or the marketing hero', () => {
    expect(section).not.toContain('CustomizeSectionWrapper');
    expect(section).not.toContain('page-header');
  });

  test('it passes the full state ladder rather than re-implementing one', () => {
    for (const prop of ['state=', 'emptyProps=', 'errorProps=', 'noResultsMessage=']) {
      expect(section).toContain(prop);
    }
    expect(section).toContain("'forbidden'");
  });

  test('title, one description, search and a single primary action', () => {
    expect(section).toContain('title="Skills"');
    expect(section).toContain('description="Reusable capabilities and slash commands');
    expect(section).toContain('search={{');
    expect(section).toContain('action=');
  });

  test('the description the shell renders is one short line', () => {
    const match = section.match(/description="([^"]*)"/);
    expect(match).not.toBeNull();
    expect((match?.[1] ?? '').length).toBeLessThanOrEqual(90);
  });
});

describe('the Skills | Commands tabs', () => {
  test('the filter row is driven by the kind order, not hand-written pills', () => {
    expect(section).toContain('filters=');
    expect(section).toContain('SKILL_KIND_ORDER.map');
  });

  test('the retired route redirects into the one Customize surface', () => {
    // Skills and Commands are sections of Customize again; the surface passes
    // `initialKind` rather than the route parsing ?tab=.
    expect(route).toContain('redirect(');
    expect(route).toContain('customize/skills');
  });

  test('switching tabs clears the selection so the modal cannot open a stale file', () => {
    expect(section).toContain('setSelectedPath(null)');
  });
});

describe('the list is a card grid', () => {
  test('two columns of cards, per the reference', () => {
    expect(section).toContain('grid gap-3 sm:grid-cols-2');
    expect(section).toContain('<SkillCard');
  });

  test('the banned list primitives stay banned', () => {
    expect(ALL).not.toContain("from '@/components/ui/list'");
    expect(ALL).not.toContain('SectionCard');
  });
});

describe('detail is a modal', () => {
  test('built on ui/modal, never a raw Dialog', () => {
    expect(detail).toContain("from '@/components/ui/modal'");
    expect(detail).not.toContain('DialogContent');
  });

  test('the section opens it instead of nesting a rail in the page', () => {
    expect(section).toContain('<SkillDetailModal');
  });
});

describe('nothing was lost', () => {
  test('creating still seeds a configure session', () => {
    expect(section).toContain('newConfigPrompt(kind)');
  });

  test('editing is reachable from both the card menu and the modal', () => {
    expect(section).toContain('editConfigPrompt(kind, entity.name, entity.path)');
    expect(detail).toContain('editConfigPrompt(kind, entity.name, entity.path)');
  });

  test('copy source survived the move into the modal', () => {
    expect(detail).toContain('Copy source');
    expect(detail).toContain('navigator.clipboard.writeText(content)');
  });

  test('the marketplace entry point is still on the screen, and now goes somewhere', () => {
    // It used to be MarketplaceSectionButton, which sets a section on the
    // Customize store — a store no mounted component reads any more.
    expect(section).toContain('useMarketplaceEnabled');
    expect(section).toContain('/marketplace`');
    expect(section).not.toContain('<MarketplaceSectionButton');
  });

  test('write access is probed per kind, so a command-only role is respected', () => {
    expect(section).toContain('PROJECT_SKILL_WRITE');
    expect(section).toContain('PROJECT_COMMAND_WRITE');
  });

  test('the docs link the empty state used to carry is still offered', () => {
    expect(section).toContain('SKILLS_DOCS_HREF');
  });
});

describe('the dead Commands section is wired again', () => {
  test('both legacy views delegate to the one screen', () => {
    expect(skillsView).toContain('<SkillsSection projectId={projectId} />');
    expect(commandsView).toContain('initialKind="command"');
  });

  test('CommandsView is no longer a component that renders nothing', () => {
    expect(commandsView).toContain('SkillsSection');
    expect(commandsView).not.toContain('ConfigEntityView');
  });
});
