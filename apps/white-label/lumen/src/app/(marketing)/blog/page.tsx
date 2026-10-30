import { NewsCards } from '@/components/marketing/bands';
import { NEWS } from '@/components/marketing/content';
import { ArrowLink, Container, Section } from '@/components/marketing/parts';
import { cn } from '@kortix/ui';
import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = { title: 'Blog', description: 'Notes on building legal AI that shows its sources.' };

export default async function BlogPage({ searchParams }: { searchParams: Promise<{ tag?: string }> }) {
  const { tag } = await searchParams;
  const tags = [...new Set(NEWS.map((n) => n.tag))];
  const items = tag ? NEWS.filter((n) => n.tag === tag) : NEWS;
  const featured = NEWS[1];
  return (
    <>
      <Section rule={false} className="pt-20! pb-12! md:pt-28!">
        <Container className="flex flex-col items-center text-center">
          <h1 className="display-xl text-[clamp(4rem,10vw,8rem)]!">Blog</h1>
          <p className="mt-6 max-w-md text-[17px] text-muted-foreground">Notes on building legal AI that shows its sources.</p>
        </Container>
      </Section>
      <Container>
        <div className="grid items-center gap-8 md:grid-cols-12">
          <div className="pattern-laid-paper grid aspect-[16/10] place-items-center rounded-[4px] md:col-span-6">
            <div className="flex items-end gap-2" aria-hidden>
              {[38, 55, 47, 70, 64, 82, 93].map((h, i) => (
                <span key={i} className="w-7 rounded-t-[2px] bg-[repeating-linear-gradient(135deg,var(--foreground)_0_1.5px,transparent_1.5px_5px)] opacity-60" style={{ height: h * 2 }} />
              ))}
            </div>
          </div>
          <div className="md:col-span-5 md:col-start-8">
            <p className="text-[14px] text-muted-foreground">Featured · {featured.tag}</p>
            <h2 className="mt-3 text-[30px] leading-[1.12] font-[470] tracking-[-0.03em]">{featured.title}</h2>
            <p className="mt-2 text-[14px] text-muted-foreground">{featured.date}</p>
            <ArrowLink href={`/blog/${featured.slug}`} tone="muted" className="mt-6">
              Read the post
            </ArrowLink>
          </div>
        </div>
      </Container>
      <Section>
        <Container>
          <nav aria-label="Topics" className="mb-12 flex flex-wrap gap-2">
            {[undefined, ...tags].map((t) => {
              const count = t ? NEWS.filter((n) => n.tag === t).length : NEWS.length;
              return (
                <Link
                  key={t ?? 'all'}
                  href={t ? `/blog?tag=${encodeURIComponent(t)}` : '/blog'}
                  aria-current={t === tag ? 'page' : undefined}
                  className={cn(
                    'rounded-full px-4 py-1.5 text-[14px] transition-colors',
                    t === tag ? 'bg-foreground text-background' : 'bg-foreground/[0.05] text-foreground hover:bg-foreground/[0.09]',
                  )}
                >
                  {t ?? 'All'} <span className="ml-1 opacity-50">{count}</span>
                </Link>
              );
            })}
          </nav>
          <NewsCards items={items} />
        </Container>
      </Section>
    </>
  );
}
