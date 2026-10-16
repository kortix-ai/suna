import { describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

// The pre-refactor Hero read auth for disabled CTAs. Keep this collaborator
// stub so the same characterization runs against the base and the refactor.
mock.module('@/features/providers/auth-provider', () => ({ useAuth: () => ({ user: null }) }));

const { default: Hero, RivalEyebrow } = await import('./hero');
const { ROLES, getRole } = await import('./solutions/registry');
const { default: SolutionsPage } = await import('../../app/[locale]/(public)/(marketing)/solutions/page');
const { default: SolutionRolePage, generateStaticParams } = await import('../../app/[locale]/(public)/(marketing)/solutions/[role]/page');

describe('hero and solutions characterization', () => {
  test('Hero renders its shipped fold without CTA buttons', () => {
    const html = renderToStaticMarkup(<Hero />);
    expect(html).toMatchSnapshot();
    expect(html).toContain('id="hero"');
    expect(html).toContain('id="demo"');
    expect(html).not.toContain('Request demo');
    expect(html).not.toContain('Get started');
  });

  test('RivalEyebrow renders both supported logos and the separator', () => {
    expect(renderToStaticMarkup(<RivalEyebrow content={{
      lead: 'Compare with',
      rivals: [
        { id: 'claude', icon: 'Claude', label: 'Claude' },
        { id: 'openai', icon: 'OpenAI', label: 'OpenAI' },
      ],
    }} />)).toMatchSnapshot();
  });

  test('RivalEyebrow renders an empty rival list', () => {
    expect(renderToStaticMarkup(<RivalEyebrow content={{ lead: 'Compare with', rivals: [] }} />)).toMatchSnapshot();
  });

  test('RivalEyebrow retains a label when its icon is unknown', () => {
    const html = renderToStaticMarkup(<RivalEyebrow content={{
      lead: 'Compare with',
      rivals: [{ id: 'synthetic', icon: 'Unknown', label: 'Synthetic rival' }],
    }} />);
    expect(html).toMatchSnapshot();
    expect(html).toContain('Synthetic rival');
    expect(html).not.toContain('<svg');
  });

  test('role lookup preserves nav order, identity and exact matching', () => {
    expect(ROLES.map(role => role.slug)).toEqual([
      'sales', 'marketing', 'product', 'engineering', 'finance', 'people', 'it', 'data-science',
    ]);
    for (const role of ROLES) expect(getRole(role.slug)).toBe(role);
    for (const slug of ['', 'unknown', 'Sales', ' sales', 'sales/']) expect(getRole(slug)).toBeUndefined();
    expect(generateStaticParams()).toEqual(ROLES.map(role => ({ role: role.slug })));
  });

  test('solutions hub renders all role links', () => {
    const html = renderToStaticMarkup(SolutionsPage());
    expect(html).toMatchSnapshot();
    for (const role of ROLES) expect(html).toContain(`href="/solutions/${role.slug}"`);
  });

  for (const role of ROLES) {
    test(`solution route renders ${role.slug}`, async () => {
      const html = renderToStaticMarkup(await SolutionRolePage({ params: Promise.resolve({ role: role.slug }) }));
      expect(html).toMatchSnapshot();
      for (const id of ['handoff', 'output', 'reach', 'cadence', 'control', 'other-teams']) {
        expect(html).toContain(`id="${id}"`);
      }
      expect(html).toContain('href="/auth"');
      expect(html).toContain('href="/contact"');
      expect(html).toContain('href="/solutions"');
      expect(html).not.toContain(`href="/solutions/${role.slug}"`);
    });
  }

  test('unknown solution route returns Next notFound', async () => {
    await expect(SolutionRolePage({ params: Promise.resolve({ role: 'unknown' }) })).rejects.toThrow('NEXT_HTTP_ERROR_FALLBACK;404');
  });
});
