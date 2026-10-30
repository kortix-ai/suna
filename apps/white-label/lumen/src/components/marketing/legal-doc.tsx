import { Container, Section } from './parts';

/** A long-form legal page: a contents column on the left, the text on the right. */
export function LegalDoc({ title, updated, sections }: { title: string; updated: string; sections: { heading: string; body: string[] }[] }) {
  const id = (h: string) => h.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return (
    <Section rule={false} className="pt-16! md:pt-24!">
      <Container className="grid gap-12 lg:grid-cols-12">
        <aside className="lg:col-span-3">
          <p className="text-[14px] text-muted-foreground">Legal</p>
          <h1 className="display-sm mt-3">{title}</h1>
          <p className="mt-3 text-[14px] text-muted-foreground">Last updated {updated}</p>
          <nav aria-label="Contents" className="mt-10 hidden space-y-2 lg:block">
            {sections.map((s) => (
              <a key={s.heading} href={`#${id(s.heading)}`} className="block text-[14px] text-muted-foreground hover:text-foreground">
                {s.heading}
              </a>
            ))}
          </nav>
        </aside>
        <article className="space-y-10 lg:col-span-7 lg:col-start-5">
          <p className="rounded-[4px] bg-paper px-4 py-3 text-[14px] text-muted-foreground">
            Sample text for a reference deployment. A partner who runs Lumen publishes its own terms and notice.
          </p>
          {sections.map((s) => (
            <section key={s.heading} id={id(s.heading)} className="scroll-mt-28">
              <h2 className="text-[22px] font-[470] tracking-[-0.025em]">{s.heading}</h2>
              {s.body.map((p) => (
                <p key={p.slice(0, 24)} className="mt-3 text-[16px] leading-[1.65] text-muted-foreground">
                  {p}
                </p>
              ))}
            </section>
          ))}
        </article>
      </Container>
    </Section>
  );
}
