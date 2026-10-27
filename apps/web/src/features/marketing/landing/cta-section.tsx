'use client';

import { useRequestDemo } from '@/features/contact/request-demo-provider';
import { DitherField } from '@/features/marketing/kit/dither-field';
import { MarketingButton } from '@/features/marketing/kit/marketing-button';
import { ctaDoors, getLocalizedLandingContent } from '@/features/marketing/landing/content';
import { footerCtaFor } from '@/features/marketing/landing/footer-cta';
import { useAuth } from '@/features/providers/auth-provider';
import { useTranslations } from '@/i18n/use-translations';
import { trackCtaSignup } from '@/lib/analytics/gtm';
import { Copy } from '@kortix/ui/icons';
import { HoverPrefetchLink } from '@kortix/ui/internal/components/hover-prefetch-link';
import { SolidCheckIcon } from '@kortix/ui/internal/icons/solid-check-icon';
import { latestProjectPath } from '@kortix/ui/internal/lib/onboarding/last-project-cookie';
import { ArrowRightIcon, BuildingsIcon, CloudIcon, HardDrivesIcon } from '@phosphor-icons/react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';

const COPIED_MS = 1500;

/** The install command as a mono chip; the whole chip copies it. */
function CommandCopy({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(command);
    } catch {
      return; // No clipboard permission: nothing was copied, so claim nothing.
    }
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), COPIED_MS);
  };

  return (
    <button
      type="button"
      onClick={onCopy}
      aria-label={`${command}. Copy`}
      className="bg-muted group outline-ring flex w-full items-center justify-between gap-3 rounded-md px-3 py-2.5 text-left focus-visible:outline-2"
    >
      <code className="text-foreground font-mono text-xs break-all">
        <span className="text-muted-foreground select-none">$ </span>
        {command}
      </code>
      <span
        aria-hidden
        className="text-muted-foreground group-hover:text-foreground duration-normal shrink-0 transition-colors ease-out"
      >
        {copied ? <SolidCheckIcon className="text-ring size-4" /> : <Copy className="size-4" />}
      </span>
      <span className="sr-only" aria-live="polite">
        {copied ? 'Copied' : ''}
      </span>
    </button>
  );
}

/** One way in: the label with its glyph, a title, one line, then its action. */
function Door({
  icon,
  label,
  title,
  body,
  children,
}: {
  icon: ReactNode;
  label: string;
  title: string;
  body: string;
  children: ReactNode;
}) {
  return (
    <li className="bg-background flex flex-col gap-4 p-6 text-left lg:p-8">
      <div className="text-muted-foreground flex items-center gap-2 text-sm">
        {icon}
        {label}
      </div>
      <h3 className="text-foreground text-xl font-medium tracking-tight text-balance">{title}</h3>
      <p className="text-muted-foreground text-base text-pretty">{body}</p>
      <div className="mt-auto flex flex-col gap-3 pt-2">{children}</div>
    </li>
  );
}

/** A quiet text link under a door's main action. */
const DOOR_LINK =
  'text-foreground hover:text-muted-foreground outline-ring inline-flex w-fit items-center gap-1.5 rounded-sm text-sm font-medium transition-colors duration-normal ease-out focus-visible:outline-2 focus-visible:outline-offset-2';

/**
 * Closing CTA above the site map: one line that echoes the hero, then three
 * ways in, one per buyer (cloud, self-hosted, a company roll-out), then the
 * trust line. Copy lives in content.ts. A page can replace the copy and both
 * actions through `footer-cta.ts`; an override keeps the centred two-button
 * close.
 */
export function CtaSection() {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const { cta } = getLocalizedLandingContent(tI18nComplete);
  const { user } = useAuth();
  const openDemo = useRequestDemo();
  const override = footerCtaFor(usePathname() ?? '/', tI18nComplete);

  // `latestProjectPath` reads document.cookie, which the server pass cannot
  // see. Seeding with `/auth` keeps both passes identical and lets the row be a
  // real anchor: hydration adopts the remembered project afterwards. An anchor
  // is what gives the site's primary closing CTA middle-click, cmd-click and
  // "copy link address" — a button has none of them.
  //
  // `HoverPrefetchLink`, so an anonymous visitor scrolling past the footer does
  // not prefetch an authed route it will never open.
  const [launchHref, setLaunchHref] = useState('/auth');
  useEffect(() => {
    if (!user) return;
    const href = latestProjectPath(user.id);
    setLaunchHref((prev) => (prev === href ? prev : href));
  });

  return (
    <section id="cta" className="py-24 sm:py-30">
      {/* Buio's hero dither, as a flat field rather than an orb. It covers
          only the band above the heading and fades out before the title, so
          the copy sits on the plain surface. Two mask layers, added: a
          straight fade that ends at 150px across the full width, and a
          centred ellipse that carries the middle down to 300px. */}
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-81.5 [mask-image:linear-gradient(to_bottom,#000,transparent_150px),radial-gradient(50%_300px_at_50%_0,#000,transparent)]"
        aria-hidden
      >
        <DitherField />
      </div>

      {override ? (
        <div className="relative z-10 mx-auto flex w-full max-w-2xl flex-col items-center px-6 text-center">
          <h2 className="text-foreground text-2xl font-medium tracking-tight text-balance md:text-3xl lg:text-4xl">
            {override.title}
            <span className="text-muted-foreground block">{override.subtitle}</span>
          </h2>
          {override.sub ? (
            <p className="text-muted-foreground mt-4 text-lg text-pretty">{override.sub}</p>
          ) : null}
          <div className="mt-8 flex w-full flex-col items-stretch gap-3 sm:w-auto sm:flex-row sm:items-center sm:justify-center">
            <MarketingButton
              size="md"
              className="hit-area-y-1 w-full sm:w-auto sm:min-w-36"
              asChild
            >
              <HoverPrefetchLink href={override.primary.href}>
                {override.primary.label}
                <ArrowRightIcon />
              </HoverPrefetchLink>
            </MarketingButton>
            <MarketingButton
              variant="secondary"
              size="md"
              className="hit-area-y-1 w-full sm:w-auto sm:min-w-36"
              asChild
            >
              <a
                href={override.secondary.href}
                {...(override.secondary.external ? { target: '_blank', rel: 'noreferrer' } : {})}
              >
                {override.secondary.label}
              </a>
            </MarketingButton>
          </div>
        </div>
      ) : (
        <div className="relative z-10 mx-auto flex w-full max-w-7xl flex-col items-center px-6 text-center">
          <h2 className="text-foreground text-2xl font-medium tracking-tight text-balance md:text-3xl lg:text-4xl">
            {cta.title}
            <span className="text-muted-foreground block">{cta.subtitle}</span>
          </h2>

          <ul className="bg-border mt-12 grid w-full grid-cols-1 gap-px overflow-hidden rounded-lg border lg:grid-cols-3">
            <Door
              icon={<CloudIcon aria-hidden className="size-4" />}
              label={ctaDoors.cloud.label}
              title={ctaDoors.cloud.title}
              body={ctaDoors.cloud.body}
            >
              <MarketingButton size="md" className="hit-area-y-1 w-full" asChild>
                <HoverPrefetchLink href={launchHref} prefetch onClick={trackCtaSignup}>
                  {user ? ctaDoors.cloud.signedIn : cta.ctaPrimary}
                  <ArrowRightIcon />
                </HoverPrefetchLink>
              </MarketingButton>
              <Link href="/pricing" className={DOOR_LINK}>
                {ctaDoors.cloud.link}
                <ArrowRightIcon aria-hidden className="size-3.5" />
              </Link>
            </Door>
            <Door
              icon={<HardDrivesIcon aria-hidden className="size-4" />}
              label={ctaDoors.selfHost.label}
              title={ctaDoors.selfHost.title}
              body={ctaDoors.selfHost.body}
            >
              <CommandCopy command={ctaDoors.selfHost.command} />
              <Link href="/self-hosted" className={DOOR_LINK}>
                {ctaDoors.selfHost.link}
                <ArrowRightIcon aria-hidden className="size-3.5" />
              </Link>
            </Door>
            <Door
              icon={<BuildingsIcon aria-hidden className="size-4" />}
              label={ctaDoors.team.label}
              title={ctaDoors.team.title}
              body={ctaDoors.team.body}
            >
              <MarketingButton
                variant="secondary"
                size="md"
                className="hit-area-y-1 w-full"
                onClick={() => openDemo({ source: 'footer-cta' })}
              >
                {cta.ctaSecondary}
              </MarketingButton>
              <Link href="/services" className={DOOR_LINK}>
                {ctaDoors.team.link}
                <ArrowRightIcon aria-hidden className="size-3.5" />
              </Link>
            </Door>
          </ul>

          <p className="text-muted-foreground mt-6 text-sm text-pretty">{cta.trust}</p>
        </div>
      )}
    </section>
  );
}
