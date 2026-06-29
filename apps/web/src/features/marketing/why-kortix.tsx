import { KortixLetterField } from '@/components/ui/marketing/kortix-letter-field';
import { useTranslations } from 'next-intl';

type OpenRow = {
  title: string;
  body: string;
};

export function WhyKortix() {
  const tHome = useTranslations('hardcodedUi.appHomePage');

  const rows: OpenRow[] = [
    { title: tHome('openRow1Title'), body: tHome('openRow1Body') },
    { title: tHome('openRow2Title'), body: tHome('openRow2Body') },
    { title: tHome('openRow3Title'), body: tHome('openRow3Body') },
    { title: tHome('openRow4Title'), body: tHome('openRow4Body') },
  ];

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
              {tHome('openTitle')}
            </h2>
            <p className="text-background/70 text-base leading-relaxed text-balance">
              {tHome('openSubtitle')}
            </p>
          </div>

          <div className="mx-auto w-full max-w-4xl">
            {rows.map((row) => (
              <div
                key={row.title}
                className="border-background/20 grid gap-5 border-b px-0 py-11 max-md:grid-cols-1 md:grid-cols-[1fr_1.05fr] md:gap-x-16 md:gap-y-10 md:px-2 md:py-14"
              >
                <h3 className="text-xl leading-tight font-semibold tracking-tight">{row.title}</h3>
                <p className="text-background/70 text-lg leading-relaxed">{row.body}</p>
              </div>
            ))}
          </div>

          <div className="mx-auto mt-24 flex w-full max-w-3xl flex-col items-center justify-center text-center">
            <p className="text-background text-xl font-semibold text-balance">
              {tHome('openClosing')}
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

export default WhyKortix;
