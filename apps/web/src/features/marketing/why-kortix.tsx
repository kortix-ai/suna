import { KortixLetterField } from '@/components/ui/marketing/kortix-letter-field';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import type { ReactNode } from 'react';

type WhyRow = {
  title: string;
  cta: { label: string; href: string };
  body: ReactNode;
};

function useRows(): WhyRow[] {
  const tI18nHardcoded = useTranslations('hardcodedUi');

  return [
    {
      title: 'When you want to stay in control',
      cta: { label: 'See how it works', href: '#how-it-works' },
      body: (
        <>
          <p>
            {tI18nHardcoded.raw('autoFeaturesMarketingWhyKortixJsxTextWithMostToolsYou4b74710a')}
          </p>
          <p>
            <strong>
              {tI18nHardcoded.raw(
                'autoFeaturesMarketingWhyKortixJsxTextIfSomethingGoesWrong78045d2a',
              )}
            </strong>{' '}
            {tI18nHardcoded.raw('autoFeaturesMarketingWhyKortixJsxTextAndGetBackTo8122fb4b')}
          </p>
        </>
      ),
    },
    {
      title: 'When you care about security',
      cta: { label: 'Explore security', href: '#security' },
      body: (
        <>
          <p>
            {tI18nHardcoded.raw('autoFeaturesMarketingWhyKortixJsxTextEveryAIAgentYou7f5d6f06')}
          </p>
          <p>
            {tI18nHardcoded.raw(
              'autoFeaturesMarketingWhyKortixJsxTextAndInsteadOfScattered1833a24c',
            )}{' '}
            <strong>
              {tI18nHardcoded.raw('autoFeaturesMarketingWhyKortixJsxTextThereSOneKey04359483')}
            </strong>
            {tI18nHardcoded.raw('autoFeaturesMarketingWhyKortixJsxTextLessToTrackFar1c45d988')}
          </p>
        </>
      ),
    },
    {
      title: "When you'd rather own your setup",
      cta: { label: 'Read about hosting', href: '/enterprise' },
      body: (
        <>
          <p>
            {tI18nHardcoded.raw('autoFeaturesMarketingWhyKortixJsxTextKortixIsOpenSource5afa4f64')}
          </p>
          <p>
            {tI18nHardcoded.raw('autoFeaturesMarketingWhyKortixJsxTextYourDataStaysWhere3c5e3923')}
            <strong>
              {tI18nHardcoded.raw(
                'autoFeaturesMarketingWhyKortixJsxTextThePlatformIsYours4d10224d',
              )}
            </strong>
            {tI18nHardcoded.raw('autoFeaturesMarketingWhyKortixJsxTextOnYourTerms2f7966c5')}
          </p>
        </>
      ),
    },
    {
      title: 'When you want it to just work',
      cta: { label: 'Get started', href: '/auth' },
      body: (
        <>
          <p>
            {tI18nHardcoded.raw('autoFeaturesMarketingWhyKortixJsxTextYouShouldnTNeedae8350b9')}
          </p>
          <p>
            {tI18nHardcoded.raw(
              'autoFeaturesMarketingWhyKortixJsxTextPowerfulEnoughForYour214b6ca4',
            )}
            <strong>
              {tI18nHardcoded.raw(
                'autoFeaturesMarketingWhyKortixJsxTextSimpleEnoughForEveryonef376c7a7',
              )}
            </strong>
            .
          </p>
        </>
      ),
    },
  ];
}

function RowCta({ label, href }: { label: string; href: string }) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  return (
    <Link
      href={href}
      className="group text-kortix-base hit-area-6 flex w-fit items-center gap-1 text-xs tracking-widest uppercase"
    >
      {label}
      <span className="inline-block text-sm opacity-0 transition-opacity duration-150 group-hover:opacity-100">
        {tI18nHardcoded.raw('autoFeaturesMarketingWhyKortixJsxText99e0d65c')}
      </span>
    </Link>
  );
}

export function WhyKortix() {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const rows = useRows();

  return (
    <section className="bg-foreground text-background relative overflow-hidden">
      <div
        className="pointer-events-none absolute inset-0 z-10 mask-y-from-10% opacity-35"
        aria-hidden
      >
        <KortixLetterField seed={3382} className="invert" />
      </div>

      <div className="px-6 py-16 sm:py-24 lg:px-0">
        <div className="z-20 mx-auto max-w-6xl">
          <div className="mx-auto mb-16 max-w-2xl space-y-3 text-center">
            <h2 className="text-background text-3xl font-medium tracking-tight sm:text-4xl">
              {tI18nHardcoded.raw('autoFeaturesMarketingWhyKortixJsxTextWhyKortix55f4edea')}
            </h2>
            <p className="text-background/70 text-base leading-relaxed text-balance">
              {tI18nHardcoded.raw(
                'autoFeaturesMarketingWhyKortixJsxTextEveryAIPlatformSounds31a0bf4e',
              )}
            </p>
          </div>

          <div className="mx-auto w-full max-w-4xl">
            {rows.map((row) => (
              <div
                key={row.title}
                className="border-background/20 grid gap-5 border-b px-0 py-11 max-md:grid-cols-1 md:grid-cols-[1fr_1.05fr] md:gap-x-16 md:gap-y-10 md:px-2 md:py-14"
              >
                <div>
                  <h3 className="mb-3.5 text-xl leading-tight font-semibold tracking-tight md:mb-5">
                    {row.title}
                  </h3>
                  <RowCta label={row.cta.label} href={row.cta.href} />
                </div>
                <div className="text-background/70 [&_strong]:text-background space-y-3.5 text-lg leading-relaxed [&_p+p]:mt-3.5 [&_strong]:font-medium">
                  {row.body}
                </div>
              </div>
            ))}
          </div>

          <div className="mx-auto mt-28 flex w-full flex-col items-center justify-center space-y-0 text-center">
            <h1 className="text-background text-xl font-semibold text-balance">
              {tI18nHardcoded.raw('autoFeaturesMarketingWhyKortixJsxTextGetGoingFastGrow2d378210')}
            </h1>

            <h1 className="text-background text-xl font-semibold text-balance">
              {tI18nHardcoded.raw('autoFeaturesMarketingWhyKortixJsxTextKortixIsnTJustb8425b28')}
            </h1>
          </div>
        </div>
      </div>
    </section>
  );
}

export default WhyKortix;
