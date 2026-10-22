import { Container, Section } from '@/components/marketing/parts';
import { CaretRightIcon } from '@phosphor-icons/react/dist/ssr';
import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = { title: 'Legal' };

const DOCS = [
  { href: '/legal/privacy', label: 'Privacy notice' },
  { href: '/legal/terms', label: 'Terms of use' },
  { href: '/security', label: 'Security' },
];

export default function LegalIndex() {
  return (
    <Section rule={false} className="pt-20! md:pt-28!">
      <Container className="max-w-[880px]!">
        <h1 className="display-xl text-center text-[clamp(4rem,10vw,8rem)]!">Legal</h1>
        <ul className="mt-20 border-t border-hairline">
          {DOCS.map((d) => (
            <li key={d.href}>
              <Link href={d.href} className="group flex items-center justify-between border-b border-hairline py-6 text-[20px] tracking-[-0.02em]">
                {d.label}
                <CaretRightIcon className="size-4 text-muted-foreground transition-transform group-hover:translate-x-1" />
              </Link>
            </li>
          ))}
        </ul>
      </Container>
    </Section>
  );
}
