'use client';

import { ConnectorLogo } from '../../../internal/connector-logo/connector-logo';

/**
 * A catalogue app's logo in a 24px slot: the one connector logo
 * (`ConnectorLogo`), so an app reads the same here as on its connector page.
 * `slug` lets a Kortix-built app (Slack, Email, …) show its own mark.
 */
export function AppLogo({
  src,
  slug,
  className,
}: {
  src: string | null;
  slug?: string | null;
  className?: string;
}) {
  return <ConnectorLogo source={{ slug, icon: src }} size="sm" className={className} />;
}
