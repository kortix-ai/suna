import { getAllPosts } from '@/lib/blog';
import { siteMetadata } from '@/lib/site-metadata';

// RSS 2.0 feed for the blog, served at /blog/rss.xml. Standard discovery
// surface for readers and aggregators — linked from the blog pages' metadata.
export const dynamic = 'force-static';

function escape(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function GET() {
  const base = siteMetadata.url;
  const posts = getAllPosts();

  const items = posts
    .map((post) => {
      const url = `${base}${post.url}`;
      const pubDate = new Date(`${post.data.date}T00:00:00Z`).toUTCString();
      return `    <item>
      <title>${escape(post.data.title)}</title>
      <link>${url}</link>
      <guid isPermaLink="true">${url}</guid>
      <pubDate>${pubDate}</pubDate>
      <dc:creator>${escape(post.author.name)}</dc:creator>
      ${post.data.description ? `<description>${escape(post.data.description)}</description>` : ''}
      ${post.data.tags.map((t) => `<category>${escape(t)}</category>`).join('\n      ')}
    </item>`;
    })
    .join('\n');

  const lastBuild = posts[0]
    ? new Date(`${posts[0].data.date}T00:00:00Z`).toUTCString()
    : new Date(0).toUTCString();

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Kortix Blog</title>
    <link>${base}/blog</link>
    <description>Field notes on building, running, and governing AI agents that do real work.</description>
    <language>en</language>
    <lastBuildDate>${lastBuild}</lastBuildDate>
    <atom:link href="${base}/blog/rss.xml" rel="self" type="application/rss+xml" />
${items}
  </channel>
</rss>`;

  return new Response(xml, {
    headers: {
      'Content-Type': 'application/rss+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600, s-maxage=3600',
    },
  });
}
