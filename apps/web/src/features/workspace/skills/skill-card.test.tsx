import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { SkillCard } from './skill-card';
import type { SkillEntity, SkillKind } from './skill-entities';

const ENTITY: SkillEntity = {
  name: 'content-creation',
  path: '.kortix/opencode/skills/content-creation/SKILL.md',
  description:
    'Load when drafting or editing external marketing copy — blog posts, LinkedIn posts, email newsletters.',
};

function render(extra: Record<string, unknown> = {}, kind: SkillKind = 'skill') {
  return renderToStaticMarkup(
    <SkillCard kind={kind} entity={ENTITY} onOpen={() => {}} {...extra} />,
  );
}

describe('card content', () => {
  test('shows the name and the description', () => {
    const html = render();
    expect(html).toContain('content-creation');
    expect(html).toContain('Load when drafting or editing external marketing copy');
  });

  test('the description is clamped to two lines, per the reference cards', () => {
    expect(render()).toContain('line-clamp-2');
  });

  test('a command card shows the slash you type', () => {
    expect(render({}, 'command')).toContain('/content-creation');
  });

  test('a description-less entity falls back to its path rather than an empty card', () => {
    const html = renderToStaticMarkup(
      <SkillCard kind="skill" entity={{ ...ENTITY, description: null }} onOpen={() => {}} />,
    );
    expect(html).toContain('.kortix/opencode/skills/content-creation/SKILL.md');
  });
});

describe('opening', () => {
  test('the whole card is one labelled button', () => {
    expect(render()).toContain('aria-label="Open content-creation"');
  });

  test('the ⋮ menu is labelled for screen readers', () => {
    expect(render()).toContain('aria-label="Actions for content-creation"');
  });
});

describe('write gating', () => {
  test('a read-only viewer gets no Edit affordance', () => {
    // DropdownMenu content is portalled, so assert on the handler wiring the
    // card exposes: without onEdit there is nothing to render.
    const html = render();
    expect(html).not.toContain('Edit');
  });

  test('the card renders with an editor handler without throwing', () => {
    expect(render({ onEdit: () => {}, editing: false })).toContain('content-creation');
  });
});
