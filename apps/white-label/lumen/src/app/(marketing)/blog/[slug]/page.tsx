import { CtaBand } from '@/components/marketing/bands';
import { NEWS, POSTS, postBySlug } from '@/components/marketing/content';
import { Container, Section } from '@/components/marketing/parts';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

export const dynamicParams = false;
// Every newsroom item has a page; the ones without a long-form post show their summary.
export const generateStaticParams = () => NEWS.map((n) => ({ slug: n.slug }));

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const n = NEWS.find((x) => x.slug === slug);
  return n ? { title: n.title } : {};
}

export default async function PostPage({ params }: { params: Promise<{ slug: string }> }) {
  const slug = (await params).slug;
  const item = NEWS.find((n) => n.slug === slug);
  if (!item) notFound();
  const post = postBySlug(slug);
  return (
    <>
      <Section rule={false} className="pt-16! pb-12! md:pt-24!">
        <Container className="flex flex-col items-center text-center">
          <nav aria-label="Breadcrumb" className="flex items-center gap-2 text-[15px] font-medium">
            <Link href="/blog" className="hover:text-muted-foreground">
              Blog
            </Link>
            <span className="text-muted-foreground">/</span>
            <span>{item.tag}</span>
          </nav>
          <h1 className="display-md mt-8 max-w-4xl text-balance">{item.title}</h1>
          <p className="mt-6 text-[15px] text-muted-foreground">{item.date}</p>
        </Container>
      </Section>
      <Section>
        <Container>
          <article className="mx-auto max-w-[680px]">
            {post ? (
              <>
                <p className="font-display text-[24px] leading-[1.4] tracking-[-0.015em] [font-variation-settings:'opsz'_24]">{post.lead}</p>
                {post.sections.map((s) => (
                  <section key={s.heading} className="mt-12">
                    <h2 className="text-[24px] font-[470] tracking-[-0.03em]">{s.heading}</h2>
                    {s.paragraphs.map((p) => (
                      <p key={p.slice(0, 24)} className="mt-4 text-[17px] leading-[1.65] text-muted-foreground">
                        {p}
                      </p>
                    ))}
                  </section>
                ))}
              </>
            ) : (
              <p className="text-[17px] leading-[1.65] text-muted-foreground">
                The full post is on its way. Until then, the platform pages describe what shipped.
              </p>
            )}
            <p className="mt-16 border-t border-hairline pt-6 text-[14px] text-muted-foreground">
              More in <Link href={`/blog?tag=${encodeURIComponent(item.tag)}`} className="text-foreground underline underline-offset-4">{item.tag}</Link>
              {' · '}
              {POSTS.length} long-form posts so far
            </p>
          </article>
        </Container>
      </Section>
      <CtaBand />
    </>
  );
}
