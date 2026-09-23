import Link from 'next/link';
import { type ComponentProps, forwardRef } from 'react';

import { isStaticSitePath } from '@/lib/navigation/static-site-path';

type SiteLinkProps = ComponentProps<typeof Link>;

/**
 * Drop-in for `next/link` wherever an href may point at `/docs` or another
 * static, non-App-Router path (see `isStaticSitePath`). Those render a plain
 * `<a>`: no RSC prefetch that 404s, no failed soft navigation before the
 * document load. Every other href is an ordinary `next/link`.
 */
const SiteLink = forwardRef<HTMLAnchorElement, SiteLinkProps>(function SiteLink(props, ref) {
  if (isStaticSitePath(props.href)) {
    // Router-only props have no meaning on a document navigation.
    const {
      href,
      as: _as,
      replace: _replace,
      scroll: _scroll,
      shallow: _shallow,
      passHref: _passHref,
      prefetch: _prefetch,
      unstable_dynamicOnHover: _dynamicOnHover,
      locale: _locale,
      legacyBehavior: _legacyBehavior,
      onNavigate: _onNavigate,
      transitionTypes: _transitionTypes,
      ...anchorProps
    } = props;
    return <a ref={ref} href={href as string} {...anchorProps} />;
  }
  return <Link ref={ref} {...props} />;
});

export default SiteLink;
