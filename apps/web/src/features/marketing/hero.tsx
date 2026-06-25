import { InteractiveDemoSection } from '@/components/home/interactive-demo-section';
import { Button } from '@/components/ui/marketing/button';
import { KortixLetterField } from '@/components/ui/marketing/kortix-letter-field';
import { WallpaperBackground } from '@/components/ui/wallpaper-background';
import { useAuth } from '@/features/providers/auth-provider';
import { trackCtaSignup } from '@/lib/analytics/gtm';
import { Message as MessageSquare, PanelTop, Terminal, ArrowRight as HiArrowRight } from '@mynaui/icons-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useCallback } from 'react';

const SURFACES = [
  { label: 'Slack', icon: MessageSquare },
  { label: 'Web workspace', icon: PanelTop },
  { label: 'CLI', icon: Terminal },
] as const;

const Hero = () => {
  const { user } = useAuth();
  const tHardcodedUi = useTranslations('hardcodedUi');
  const tHome = useCallback(
    (key: string) => tHardcodedUi.raw(`appHomePage.${key}`),
    [tHardcodedUi],
  );

  const handleLaunch = useCallback(() => {
    trackCtaSignup();
    window.location.href = user ? '/projects' : '/auth';
  }, [user]);

  return (
    <section id="hero" className="relative overflow-hidden px-6 pt-32 pb-12 sm:py-36">
      <div className="pointer-events-none absolute inset-0 z-0 mask-y-to-95%" aria-hidden>
        <KortixLetterField seed={3382} />
      </div>
      <div className="inset-0 z-0 hidden mask-t-from-70% lg:absolute">
        <WallpaperBackground wallpaperId="brandmark" />
      </div>

      <div className="z-20">
        <section className="mx-auto w-full max-w-6xl">
          <h1 className="text-foreground mt-5 text-4xl leading-[1.1] font-medium tracking-tight md:text-5xl">
            {tHome('heroCommandCenter')}
            <br />
            <span className="text-muted-foreground">{tHome('heroAiWorkforce')}</span>
          </h1>
          <p className="text-muted-foreground mt-6 max-w-xl text-lg leading-relaxed">
            {tHome('heroDescription')}
          </p>

          <div className="mt-8 flex flex-wrap gap-3">
            <Button size="xl" onClick={handleLaunch}>
              {tHome('startBuildingCta')}
              <HiArrowRight className="size-4" />
            </Button>
            <Button size="xl" variant="secondary" asChild>
              <Link href={'/enterprise'}>{tHome('line149JsxTextTalkToSales')}</Link>
            </Button>
          </div>
        </section>

        <div id="demo" className="relative z-10 mx-auto mt-14 max-w-6xl scroll-mt-24 sm:mt-20">
          <InteractiveDemoSection />
        </div>
      </div>
    </section>
  );
};

export default Hero;
