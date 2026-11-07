import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Post } from '@/lib/blog';
import { UseCaseCard } from './use-case-card';

const post: Post = {
  slug: 'synthetic-workflow', url: '/use-cases/synthetic-workflow',
  data: { title: 'Synthetic workflow', date: '2026-10-25', author: 'team', tags: ['Operations'], draft: false },
  author: { name: 'Synthetic author', role: 'Test', email: 'agent@kortix.ai' }, readingTime: 2,
};

describe('UseCaseCard live renderer', () => {
  it('keeps the title, link, metadata and fallback cover', () => {
    const markup = renderToStaticMarkup(<UseCaseCard post={post} />);
    expect(markup).toContain('href="/use-cases/synthetic-workflow"');
    expect(markup).toContain('Synthetic workflow</h3>');
    expect(markup).toContain('Operations');
    expect(markup).toContain('dateTime="2026-10-25"');
    expect(markup).toContain('October 25, 2026');
    expect(markup).toContain('animate-kortix-bullet-flow');
    expect(markup).not.toContain('<img');
  });

  it('uses a frontmatter cover instead of the fallback', () => {
    const markup = renderToStaticMarkup(<UseCaseCard post={{ ...post, data: { ...post.data, cover: '/synthetic-cover.png', tags: [] } }} />);
    expect(markup).toContain('<img');
    expect(markup).toContain('alt="Synthetic workflow"');
    expect(markup).toContain('synthetic-cover.png');
    expect(markup).not.toContain('Operations');
  });
});
