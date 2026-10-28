import { CtaBand } from '@/components/marketing/bands';
import { SECURITY_PRINCIPLES } from '@/components/marketing/content';
import { ArrowLink, Container, Section } from '@/components/marketing/parts';
import { BRAND } from '@/config/brand';
import {
  CubeIcon,
  KeyIcon,
  ListChecksIcon,
  LockSimpleIcon,
  QuotesIcon,
  UsersThreeIcon,
} from '@phosphor-icons/react/dist/ssr';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Security', description: 'How Lumen handles your firm’s documents, in plain words.' };

const ICONS = { lock: LockSimpleIcon, cube: CubeIcon, quotes: QuotesIcon, users: UsersThreeIcon, list: ListChecksIcon, key: KeyIcon } as const;

const STEPS = [
  ['A lawyer asks', 'The request goes to Lumen’s server, never straight to the agent workspace. The server checks the member, the firm and the matter.'],
  ['A workspace opens', 'An isolated environment starts for this conversation or run, with the firm’s folder and the read-only agent kit mounted. Nothing else.'],
  ['The agent works', 'It reads the matter documents, runs its tools and writes its answer with citations.'],
  ['Lumen checks', 'Every quote is matched against the cited paragraph. A miss is marked unverified before anyone sees it.'],
  ['It is recorded', 'The run, its documents and every export are written to the firm’s audit log.'],
];

const LIMITS = [
  ['No training on your data', 'This is the configured policy of this deployment: model routing goes to providers that do not train on submitted content. Ask your administrator for the current provider list.'],
  ['What restricted matters do not do', 'Matters inside one firm are separated by Lumen’s access control. A matter with its own isolated workspace, for conflict-sensitive work, is planned.'],
  ['Certifications', 'This reference deployment claims no third-party certification. Each partner who runs Lumen states its own.'],
];

export default function SecurityPage() {
  return (
    <>
      <section className="pattern-laid -mt-[72px] px-6 pt-[calc(72px+6rem)] pb-28 text-center text-white md:pt-[calc(72px+9rem)] md:pb-40">
        <p className="text-[15px] text-white/65">Security</p>
        <h1 className="display-lg mx-auto mt-6 max-w-4xl text-balance">How Lumen keeps a matter confidential</h1>
        <p className="mx-auto mt-8 max-w-lg text-[18px] leading-[1.4] text-white/70">
          How Lumen handles your firm’s documents, in plain words. We make no claim here that we cannot back.
        </p>
      </section>

      <section className="bg-navy text-white">
        <Container className="grid gap-14 border-t border-white/10 py-24 lg:grid-cols-2">
          <div>
            <h2 className="display-sm max-w-md">Each firm sealed off from every other</h2>
            <p className="mt-6 max-w-sm text-[17px] leading-[1.4] text-white/65">Six controls are on for every firm, every matter and every run.</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {SECURITY_PRINCIPLES.map((p) => {
              const Icon = ICONS[p.icon];
              return (
                <div key={p.title} className="flex flex-col items-center gap-5 rounded-[4px] bg-white/[0.04] px-5 py-9 text-center">
                  <Icon className="size-12 text-white/55" weight="thin" />
                  <p className="text-[15px] text-white/85">{p.title}</p>
                </div>
              );
            })}
          </div>
        </Container>
      </section>

      <Section rule={false}>
        <Container className="grid gap-12 lg:grid-cols-12">
          <div className="lg:col-span-4">
            <h2 className="display-sm">What happens when a lawyer asks</h2>
          </div>
          <ol className="border-t border-hairline lg:col-span-7 lg:col-start-6">
            {STEPS.map(([t, b], i) => (
              <li key={t} className="grid grid-cols-[3rem_1fr] gap-4 border-b border-hairline py-7">
                <span className="font-mono text-[13px] text-muted-foreground">0{i + 1}</span>
                <div>
                  <h3 className="text-[20px] font-[470] tracking-[-0.025em]">{t}</h3>
                  <p className="mt-2 text-[16px] leading-[1.5] text-muted-foreground">{b}</p>
                </div>
              </li>
            ))}
          </ol>
        </Container>
      </Section>

      <Section>
        <Container className="grid gap-12 md:grid-cols-2">
          {SECURITY_PRINCIPLES.map((p) => {
            const Icon = ICONS[p.icon];
            return (
              <div key={p.title} className="flex gap-5">
                <Icon className="mt-1 size-5 shrink-0" />
                <div>
                  <h3 className="text-[20px] font-[470] tracking-[-0.025em]">{p.title}</h3>
                  <p className="mt-2 text-[16px] leading-[1.5] text-muted-foreground">{p.body}</p>
                </div>
              </div>
            );
          })}
        </Container>
      </Section>

      <Section className="bg-paper">
        <Container className="grid gap-12 lg:grid-cols-12">
          <div className="lg:col-span-4">
            <h2 className="display-sm">The fine print</h2>
            <ArrowLink href="/legal/privacy" tone="muted" className="mt-8">
              Privacy notice
            </ArrowLink>
          </div>
          <div className="space-y-10 lg:col-span-7 lg:col-start-6">
            {LIMITS.map(([t, b]) => (
              <div key={t}>
                <h3 className="text-[20px] font-[470] tracking-[-0.025em]">{t}</h3>
                <p className="mt-2 text-[16px] leading-[1.5] text-muted-foreground">{b}</p>
              </div>
            ))}
            {BRAND.subprocessorNote && <p className="text-[14px] text-muted-foreground">{BRAND.subprocessorNote}</p>}
          </div>
        </Container>
      </Section>

      <CtaBand title="Talk to us about your firm’s requirements" />
    </>
  );
}
