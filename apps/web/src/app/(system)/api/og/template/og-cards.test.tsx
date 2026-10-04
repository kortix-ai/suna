import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { OgFallbackCard, TemplateOgCard } from './og-cards';

const TEMPLATE = {
  is_kortix_team: true,
  name: 'Deep Research Agent',
  description: 'Digs through sources for you.',
  creator_name: 'Ada',
  download_count: 42,
  mcp_requirements: [{}, {}, {}],
  tags: ['research', 'web', 'data', 'sql', 'charts', 'extra-6', 'extra-7'],
} satisfies Parameters<typeof TemplateOgCard>[0]['template'];

describe('TemplateOgCard', () => {
  test('renders the team badge, name, description, creator and install count', () => {
    const html = renderToStaticMarkup(<TemplateOgCard template={TEMPLATE} />);
    expect(html).toContain('✨ Official Template');
    expect(html).toContain('Deep Research Agent');
    expect(html).toContain('Digs through sources for you.');
    expect(html).toContain('Ada');
    expect(html).toContain('42');
    expect(html).toContain('installs');
  });

  test('defaults the description and the creator when the template has neither', () => {
    const html = renderToStaticMarkup(
      <TemplateOgCard
        template={{ name: 'Bare Template', download_count: 0, mcp_requirements: [] }}
      />,
    );
    expect(html).toContain('Bare Template');
    expect(html).toContain('An AI agent template ready to be customized for your needs.');
    expect(html).toContain('Anonymous');
    expect(html).not.toContain('✨ Official Template');
    expect(html).not.toContain('connectors');
  });

  test('shows the connector count only when the template declares MCP requirements', () => {
    const html = renderToStaticMarkup(<TemplateOgCard template={TEMPLATE} />);
    expect(html).toContain('>3</span>');
    expect(html).toContain('connectors');
  });

  test('renders at most the first five tags', () => {
    const html = renderToStaticMarkup(<TemplateOgCard template={TEMPLATE} />);
    expect(html).toContain('research');
    expect(html).toContain('charts');
    expect(html).not.toContain('extra-6');
    expect(html).not.toContain('extra-7');
  });

  test('keeps the shared dark-gradient frame and the footer line', () => {
    const html = renderToStaticMarkup(<TemplateOgCard template={TEMPLATE} />);
    expect(html).toContain('linear-gradient(to bottom right, #1e1b4b, #0a0a0a)');
    expect(html).toContain('Kortix');
    expect(html).toContain('AI Agent Marketplace');
  });
});

describe('OgFallbackCard', () => {
  test('renders the fallback title and discovery line on the same frame', () => {
    const html = renderToStaticMarkup(<OgFallbackCard />);
    expect(html).toContain('🤖');
    expect(html).toContain('AI Agent Template');
    expect(html).toContain('Discover powerful AI agents on Kortix');
    expect(html).toContain('linear-gradient(to bottom right, #1e1b4b, #0a0a0a)');
    expect(html).not.toContain('installs');
  });
});
