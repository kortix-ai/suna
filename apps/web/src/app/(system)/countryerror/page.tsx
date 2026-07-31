'use client';

import { useTranslations } from 'next-intl';

import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { AnimatedBg } from '@/components/ui/animated-bg';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { GlobeIcon as Globe, EnvelopeIcon as Mail } from '@phosphor-icons/react';
import Link from 'next/link';

export default function CountryError() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  return (
    <div className="relative min-h-[100dvh] w-full overflow-hidden">
      <div className="relative flex min-h-[100dvh] w-full flex-col items-center justify-center px-3 py-8 sm:px-6">
        {/* Animated background */}
        <AnimatedBg variant="hero" />

        <div className="relative z-10 flex w-full max-w-[456px] flex-col items-center gap-5 sm:gap-8">
          {/* Logo */}
          <KortixLogo size={28} className="sm:h-8 sm:w-8" />

          {/* Title */}
          <h1 className="text-foreground text-center text-2xl leading-tight font-normal tracking-tight sm:text-3xl md:text-5xl">
            {tHardcodedUi.raw('appCountryerrorPage.line23JsxTextNotAvailableInYourCountry')}
          </h1>

          {/* Description */}
          <p className="text-foreground/60 px-2 text-center text-sm leading-relaxed sm:text-base">
            {tHardcodedUi.raw(
              'appCountryerrorPage.line28JsxTextWeReSorryKortixIsCurrentlyUnavailableIn',
            )}
          </p>

          {/* Status Card */}
          <Card className="bg-card border-border h-24 w-full border">
            <CardContent className="flex h-full items-center justify-between p-6">
              <div className="flex items-center gap-3">
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-blue-500/10">
                  <Globe className="h-6 w-6 text-blue-500" />
                </div>
                <div className="flex flex-col gap-0.5">
                  <span className="text-foreground text-sm font-medium">
                    {tHardcodedUi.raw('appCountryerrorPage.line41JsxTextRegionRestricted')}
                  </span>
                  <span className="text-foreground/60 text-sm">
                    {tHardcodedUi.raw(
                      'appCountryerrorPage.line44JsxTextServiceNotAvailableInYourLocation',
                    )}
                  </span>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Action Buttons */}
          <div className="flex w-full flex-col gap-3">
            <Button
              asChild
              size="lg"
              variant="outline"
              className="h-12 w-full rounded-lg font-medium"
            >
              <Link
                href="mailto:support@kortix.ai"
                className="flex items-center justify-center gap-2"
              >
                <Mail className="h-4 w-4" />
                <span>{tHardcodedUi.raw('appCountryerrorPage.line64JsxTextContactSupport')}</span>
              </Link>
            </Button>
          </div>

          {/* Footer text */}
          <p className="text-foreground/40 text-center text-sm">
            {tHardcodedUi.raw('appCountryerrorPage.line71JsxTextIfYouBelieveThisIsAnErrorPlease')}
          </p>
        </div>
      </div>
    </div>
  );
}
