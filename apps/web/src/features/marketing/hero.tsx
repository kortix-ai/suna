import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/marketing/button';
import { KortixLetterField } from '@/components/ui/marketing/kortix-letter-field';
import { WallpaperBackground } from '@/components/ui/wallpaper-background';
import { useRequestDemo } from '@/features/contact/request-demo-provider';
import { HeroSurfaces } from '@/features/marketing/hero-surfaces';
import { useAuth } from '@/features/providers/auth-provider';
import { trackCtaSignup } from '@/lib/analytics/gtm';
import { useTranslations } from 'next-intl';
import { useCallback } from 'react';
import { HiArrowRight } from 'react-icons/hi2';

const Hero = () => {
  const { user } = useAuth();
  const openDemo = useRequestDemo();
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
          <Badge variant="kortix" className="rounded">
            {tHome('heroEyebrow')}
          </Badge>
          <h1 className="text-foreground mt-6 text-4xl font-medium tracking-tight text-balance sm:text-5xl lg:text-6xl">
            {tHome('heroCommandCenter')}
          </h1>
          <p className="text-muted-foreground mt-5 text-xl font-normal tracking-tight text-balance sm:text-2xl">
            {tHome('heroAiWorkforce')}
          </p>
          <p className="text-muted-foreground mt-5 max-w-xl text-base leading-relaxed">
            {tHome('heroDescription')}
          </p>

          <div className="mt-8 flex flex-wrap gap-3">
            <Button size="xl" onClick={handleLaunch}>
              {tHome('startBuildingCta')}
              <HiArrowRight className="size-4" />
            </Button>
            <Button size="xl" variant="secondary" onClick={openDemo}>
              {tHome('line149JsxTextTalkToSales')}
            </Button>
          </div>
        </section>

        <div id="demo" className="relative z-10 mx-auto mt-14 max-w-6xl scroll-mt-24 sm:mt-20">
          <HeroSurfaces />
        </div>
      </div>
    </section>
  );
};

export default Hero;
