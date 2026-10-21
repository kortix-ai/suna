import { cn } from '@kortix/ui';
import {
  CubeIcon,
  KeyIcon,
  ListChecksIcon,
  LockSimpleIcon,
  QuotesIcon,
  UsersThreeIcon,
} from '@phosphor-icons/react/dist/ssr';
import Link from 'next/link';
import { FIRMS, type Feature, NEWS, RESULTS, SECURITY_PRINCIPLES, STORIES } from './content';
import { Mock } from './mocks';
import { ArrowLink, Container, FirmLockup, MediaCard, Photo, PillLink, Section, SectionTitle } from './parts';

const ICONS = { lock: LockSimpleIcon, cube: CubeIcon, quotes: QuotesIcon, users: UsersThreeIcon, list: ListChecksIcon, key: KeyIcon } as const;

/** The trust band: brand surface, serif title left, six principles right. */
export function SecurityBand({ className }: { className?: string }) {
  return (
    <section className={cn('bg-navy text-white', className)}>
      <Container className="grid gap-14 py-24 md:py-32 lg:grid-cols-2">
        <div>
          <h2 className="display-sm max-w-md">Your matters, protected by default</h2>
          <p className="mt-6 max-w-sm text-[17px] leading-[1.4] text-white/65">
            Each firm works in its own walled workspace, every task in its own isolated environment, and every citation is checked before it is
            shown.
          </p>
          <ArrowLink href="/security" tone="light" className="mt-10">
            How Lumen handles your data
          </ArrowLink>
        </div>
        <div className="grid gap-x-10 gap-y-12 sm:grid-cols-2">
          {SECURITY_PRINCIPLES.map((p) => {
            const Icon = ICONS[p.icon];
            return (
              <div key={p.title}>
                <Icon className="size-5" />
                <p className="mt-4 text-[16px] font-medium tracking-[-0.01em]">{p.title}</p>
                <p className="mt-1.5 text-[15px] leading-[1.45] text-white/60">{p.body}</p>
              </div>
            );
          })}
        </div>
      </Container>
    </section>
  );
}

/** The closing call to action: one serif line, two actions. */
export function CtaBand({ title = 'Bring Lumen to your firm' }: { title?: string }) {
  return (
    <Section>
      <Container className="flex flex-col items-center text-center">
        <h2 className="display-md max-w-3xl text-balance">{title}</h2>
        <p className="mt-6 max-w-md text-lg text-muted-foreground">Start a free trial with the sample matter, or let us walk your team through it.</p>
        <div className="mt-10 flex flex-wrap justify-center gap-3">
          <PillLink href="/demo" arrow>
            Request demo
          </PillLink>
          <PillLink href="/sign-up" variant="outline">
            Start free trial
          </PillLink>
        </div>
      </Container>
    </Section>
  );
}

/** Feature rows: a paper media card opposite a title, alternating sides. */
export function FeatureRows({ features, titleStyle = 'sans' }: { features: Feature[]; titleStyle?: 'sans' | 'serif' }) {
  return (
    <div className="space-y-24 md:space-y-32">
      {features.map((f, i) => (
        <div key={f.title} className="grid items-center gap-10 md:grid-cols-2 md:gap-6">
          <div className={cn(i % 2 && 'md:order-2')}>
            <MediaCard>
              <Mock name={f.mock} />
            </MediaCard>
          </div>
          <div className={cn('md:px-16 lg:px-24', i % 2 && 'md:order-1')}>
            {titleStyle === 'serif' ? (
              <h3 className="display-sm">{f.title}</h3>
            ) : (
              <h3 className="border-b border-hairline pb-5 text-[28px] leading-[1.1] font-[470] tracking-[-0.03em] md:text-[32px]">{f.title}</h3>
            )}
            <p className="mt-5 max-w-md text-[17px] leading-[1.45] text-muted-foreground">{f.body}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

/** A row of type-only lockups for fictional firms. */
export function LogoWall({ caption }: { caption: string }) {
  return (
    <Section rule={false} className="py-20! md:py-24!">
      <Container>
        <p className="text-center text-[17px] font-medium tracking-[-0.01em]">{caption}</p>
        <div className="mt-12 grid grid-cols-2 items-center gap-x-6 gap-y-10 text-muted-foreground sm:grid-cols-3 lg:grid-cols-6">
          {FIRMS.map((f) => (
            <div key={f.name} className="flex justify-center opacity-80">
              <FirmLockup name={f.name} style={f.style} />
            </div>
          ))}
        </div>
      </Container>
    </Section>
  );
}

export function Quote({ quote, person, role }: { quote: string; person: string; role: string }) {
  return (
    <Section>
      <Container className="flex flex-col items-center text-center">
        <blockquote className="max-w-4xl text-[24px] leading-[1.3] font-[430] tracking-[-0.025em] text-balance md:text-[30px]">“{quote}”</blockquote>
        <p className="mt-8 text-[15px] font-medium">{person}</p>
        <p className="text-[15px] text-muted-foreground">{role}</p>
      </Container>
    </Section>
  );
}

export function Results() {
  return (
    <Section>
      <Container>
        <SectionTitle>Measured, not promised</SectionTitle>
        <div className="mt-20 grid gap-12 md:grid-cols-3">
          {RESULTS.map((r) => (
            <div key={r.caption} className="text-center md:text-left">
              <p className="text-[72px] leading-none font-[300] tracking-[-0.05em] md:text-[96px]">
                {r.value}
                <span className="align-top text-[0.42em] text-muted-foreground">{r.unit}</span>
              </p>
              <p className="mx-auto mt-4 max-w-xs text-[16px] leading-[1.4] text-muted-foreground md:mx-0">{r.caption}</p>
            </div>
          ))}
        </div>
        <p className="mt-14 text-center text-[13px] text-muted-foreground md:text-left">
          Measured on Lumen’s synthetic evaluation set: fictional contracts with planted issues, scored by the evaluation harness in the agent kit.
        </p>
      </Container>
    </Section>
  );
}

/** Dark story cards: an abstract interior with the firm's lockup, a sans title below. */
export function StoryCards({ limit, className }: { limit?: number; className?: string }) {
  return (
    <div className={cn('grid gap-6 md:grid-cols-2', className)}>
      {STORIES.slice(0, limit).map((s) => (
        <Link key={s.slug} href={`/customers/${s.slug}`} className="group">
          <Photo tone={s.tone} className="grid aspect-[16/10] place-items-center">
            <FirmLockup name={s.firm} style={s.style} className="relative scale-125 text-white" />
          </Photo>
          <p className="mt-4 max-w-lg text-[20px] leading-[1.25] font-[460] tracking-[-0.025em] transition-colors group-hover:text-muted-foreground md:text-[24px]">
            {s.title}
          </p>
        </Link>
      ))}
    </div>
  );
}

/** Paper cards with type-only art: the newsroom and the blog. */
export function NewsCards({ items = NEWS.slice(0, 3), cols = 3 }: { items?: typeof NEWS; cols?: 2 | 3 }) {
  return (
    <div className={cn('grid gap-x-6 gap-y-12 sm:grid-cols-2', cols === 3 && 'lg:grid-cols-3')}>
      {items.map((n, i) => (
        <Link key={n.slug} href={`/blog/${n.slug}`} className="group">
          <div
            className={cn(
              'relative grid aspect-[4/3] place-items-center overflow-hidden rounded-[4px] p-8 transition-opacity group-hover:opacity-90',
              i % 3 === 0 ? 'pattern-laid text-white' : 'bg-paper',
            )}
          >
            <p className="display-xs max-w-[80%] text-center">{n.title}</p>
          </div>
          <p className="mt-4 text-[17px] leading-[1.3] font-medium tracking-[-0.015em]">{n.title}</p>
          <p className="mt-1 text-[14px] text-muted-foreground">
            {n.date} · {n.tag}
          </p>
        </Link>
      ))}
    </div>
  );
}
