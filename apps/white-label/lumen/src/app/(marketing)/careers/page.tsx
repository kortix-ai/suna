import { ROLES } from '@/components/marketing/content';
import { ArrowLink, BrandFrame, Container, Lead, Section } from '@/components/marketing/parts';
import { ArrowRightIcon } from '@phosphor-icons/react/dist/ssr';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Careers', description: 'Open roles at Lumen.' };

const VALUES = [
  ['Lawyers in the room', 'Legal engineers sit with product and engineering. Every feature starts from a real matter.'],
  ['Small and senior', 'A small team that owns its work end to end, from the first sketch to the eval score.'],
  ['Evidence over opinion', 'We settle arguments with a measurement, then write it down.'],
];

export default function CareersPage() {
  const teams = [...new Set(ROLES.map((r) => r.team))];
  return (
    <>
      <Section rule={false} className="pt-20! pb-16! md:pt-28!">
        <Container className="flex flex-col items-center text-center">
          <h1 className="display-lg max-w-4xl text-balance">Help us build the next era of legal work</h1>
          <Lead className="mt-8 max-w-lg">We are a small team of engineers, designers and lawyers. Come and do the best work of your career.</Lead>
          <ArrowLink href="#roles" className="mt-10">
            See open roles
          </ArrowLink>
        </Container>
      </Section>
      <Container>
        <BrandFrame className="grid aspect-[16/7] place-items-center">
          <p className="display-md px-6 text-center text-white/90">Show the source.</p>
        </BrandFrame>
      </Container>
      <Section rule={false}>
        <Container className="grid gap-12 md:grid-cols-3">
          {VALUES.map(([t, b]) => (
            <div key={t} className="border-t border-hairline pt-6">
              <h2 className="text-[24px] font-[470] tracking-[-0.03em]">{t}</h2>
              <p className="mt-3 text-[16px] leading-[1.5] text-muted-foreground">{b}</p>
            </div>
          ))}
        </Container>
      </Section>
      <Section id="roles">
        <Container className="grid gap-12 lg:grid-cols-12">
          <h2 className="display-sm lg:col-span-4">Open roles</h2>
          <div className="space-y-12 lg:col-span-8">
            {teams.map((t) => (
              <div key={t}>
                <p className="mb-2 text-[14px] text-muted-foreground">{t}</p>
                <ul className="border-t border-hairline">
                  {ROLES.filter((r) => r.team === t).map((r) => (
                    <li key={r.title}>
                      <a href={`mailto:careers@lumen.example?subject=${encodeURIComponent(r.title)}`} className="group flex items-center gap-4 border-b border-hairline py-5">
                        <span className="flex-1 text-[20px] tracking-[-0.02em]">{r.title}</span>
                        <span className="hidden text-[15px] text-muted-foreground sm:inline">{r.place}</span>
                        <ArrowRightIcon className="size-4 transition-transform group-hover:translate-x-1" />
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            <p className="text-[13px] text-muted-foreground">Lumen is a reference product; these roles are illustrative.</p>
          </div>
        </Container>
      </Section>
    </>
  );
}
