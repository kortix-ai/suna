import { useAuth } from '@/components/AuthProvider';
import { InteractiveDemoSection } from '@/components/home/interactive-demo-section';
import { Button } from '@/components/ui/marketing/button';
import { KortixLetterField } from '@/components/ui/marketing/kortix-letter-field';
import { WallpaperBackground } from '@/components/ui/wallpaper-background';
import { useCopy } from '@/hooks/use-copy';
import { trackCtaSignup } from '@/lib/analytics/gtm';
import { Check, Copy } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { HiArrowRight } from 'react-icons/hi2';

const DEMO_URL = '/contact';
const GITHUB_URL = 'https://github.com/kortix-ai/suna';

const favicon = (d: string) => `https://www.google.com/s2/favicons?domain=${d}&sz=128`;
const DEFAULT_INSTALL_HOST = 'kortix.com';

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

  const { copied, copy } = useCopy();
  const [installHost, setInstallHost] = useState(DEFAULT_INSTALL_HOST);

  const installCmd = `curl -fsSL https://${installHost}/install | bash`;

  useEffect(() => {
    setInstallHost(window.location.host);
  }, []);

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

          <div className="bg-card mt-14 flex w-full max-w-xl min-w-0 items-center gap-4 rounded-sm border p-3 px-5">
            <div className="flex min-w-0 flex-1 gap-3 overflow-hidden">
              <span className="text-foreground shrink-0 font-mono text-sm">$ </span>
              <span className="text-foreground min-w-0 truncate font-mono text-sm select-all">
                {installCmd}
              </span>
            </div>
            <Button
              size="icon-sm"
              variant="ghost"
              className="shrink-0"
              onClick={() => copy(installCmd)}
            >
              {copied ? <Check className="text-primary size-4" /> : <Copy className="size-4" />}
            </Button>
          </div>
          <div className="mt-8 flex flex-wrap gap-3">
            <Button size="xl" onClick={handleLaunch}>
              {tHome('startBuildingCta')}
              <HiArrowRight className="size-4" />
            </Button>
            <Button size="xl" variant="secondary" asChild>
              <Link href={DEMO_URL}>{tHome('line149JsxTextTalkToSales')}</Link>
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
