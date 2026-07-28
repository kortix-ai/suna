import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { SkillDetailPanes } from './skill-detail-panes';
import type { SkillEntity, SkillKind } from './skill-entities';

const ENTITY: SkillEntity = {
  name: 'content-creation',
  path: '.kortix/opencode/skills/content-creation/SKILL.md',
  description: 'Load when drafting or editing external marketing copy.',
};

const FRONTMATTER = 'name: content-creation\ndescription: "Load when drafting."';

function render(over: Partial<{ entity: SkillEntity; kind: SkillKind; frontmatter: string }> = {}) {
  return renderToStaticMarkup(
    <SkillDetailPanes
      kind={over.kind ?? 'skill'}
      entity={over.entity ?? ENTITY}
      frontmatter={over.frontmatter ?? FRONTMATTER}
      body={<p>the rendered body</p>}
    />,
  );
}

describe('left pane', () => {
  test('About carries the description', () => {
    const html = render();
    expect(html).toContain('About');
    expect(html).toContain('Load when drafting or editing external marketing copy.');
  });

  test('About is a disclosure that starts open', () => {
    expect(render()).toContain('aria-expanded="true"');
  });

  test('Files lists the file, not the whole path', () => {
    const html = render();
    expect(html).toContain('Files');
    expect(html).toContain('SKILL.md');
  });

  test('a command lists its own .md file', () => {
    const html = render({
      kind: 'command',
      entity: { name: 'ship', path: '.kortix/opencode/commands/ship.md', description: null },
    });
    expect(html).toContain('ship.md');
  });

  test('the full path stays visible for whoever needs to find the file', () => {
    expect(render()).toContain('.kortix/opencode/skills/content-creation/SKILL.md');
  });

  test('a description-less entity says so instead of rendering a blank About', () => {
    const html = render({ entity: { ...ENTITY, description: null } });
    expect(html).toContain('This skill has no description yet.');
  });
});

describe('right pane', () => {
  test('renders the frontmatter above the body, like the reference', () => {
    const html = render();
    expect(html.indexOf('name: content-creation')).toBeLessThan(html.indexOf('the rendered body'));
  });

  test('a file with no frontmatter renders only the body', () => {
    const html = render({ frontmatter: '   ' });
    expect(html).toContain('the rendered body');
    expect(html).not.toContain('<pre');
  });
});
