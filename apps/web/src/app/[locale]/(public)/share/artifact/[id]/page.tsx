import { Button } from '@kortix/ui/button';
import { AuthFrame } from '@kortix/ui/internal/auth/auth-card-shell';
import { OutcomeTitle } from '@kortix/ui/internal/auth/auth-consent';
import { Rise, StepHeader } from '@kortix/ui/internal/auth/auth-primitives';
import type { Metadata } from 'next';

import { KortixLogo } from '@/components/sidebar/kortix-logo';
import Link from '@/components/site-link';
import { ARTIFACT_FRAME_ALLOW, ARTIFACT_IFRAME_SANDBOX } from '@/features/artifacts/frame-sandbox';
import { getTranslations } from '@/i18n/get-translations';

import { SHARE_FILE_IFRAME_CLASS, SHARE_PAGE_ROOT_CLASS } from '../../session/[token]/share-layout';

import { loadPublicArtifact } from './public-artifact';

type PublicArtifactRouteProps = {
  params: Promise<{ locale: string; id: string }>;
};

// Anyone with the link, and only them: never in a search index.
const ROBOTS: Metadata['robots'] = { index: false, follow: false };

export async function generateMetadata({ params }: PublicArtifactRouteProps): Promise<Metadata> {
  const { id } = await params;
  const t = await getTranslations('artifacts');
  const result = await loadPublicArtifact(id);
  if (result.kind !== 'shared') return { title: t('notFoundTitle'), robots: ROBOTS };
  const { title, description } = result.artifact;
  return {
    title,
    description: description ?? undefined,
    robots: ROBOTS,
    openGraph: { title, description: description ?? undefined, type: 'article' },
  };
}

/**
 * /share/artifact/[id] — a public artifact: the Kortix bar (symbol, title, one
 * action) above the page. The content server's CSP sandbox isolates the page
 * (see ARTIFACT_IFRAME_SANDBOX); it never runs with this site's origin.
 */
export default async function PublicArtifactPage({ params }: PublicArtifactRouteProps) {
  const { id } = await params;
  const t = await getTranslations('artifacts');
  const result = await loadPublicArtifact(id);

  if (result.kind !== 'shared') {
    return (
      <AuthFrame footerVariant="none">
        <Rise>
          <StepHeader
            title={<OutcomeTitle tone="muted">{result.kind === 'busy' ? t('busyTitle') : t('notFoundTitle')}</OutcomeTitle>}
            description={result.kind === 'busy' ? t('busyHint') : t('notFoundHint')}
          />
        </Rise>
        <Rise delay={0.06}>
          <Button size="lg" variant="secondary" className="w-full" asChild>
            <Link href="/">{t('tryKortix')}</Link>
          </Button>
        </Rise>
      </AuthFrame>
    );
  }

  const { artifact } = result;
  return (
    <main className={SHARE_PAGE_ROOT_CLASS}>
      <header className="flex h-12 shrink-0 items-center gap-3 pr-3 pl-4">
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <KortixLogo variant="symbol" size={16} className="shrink-0" />
          <h1 className="truncate text-sm font-medium">{artifact.title}</h1>
        </div>
        <Button size="sm" variant="secondary" asChild>
          <Link href="/">{t('tryKortix')}</Link>
        </Button>
      </header>
      <section className="bg-background border-border relative min-h-0 flex-1 overflow-hidden rounded-t-md border-x border-t">
        <iframe
          src={artifact.content_url}
          title={artifact.title}
          className={SHARE_FILE_IFRAME_CLASS}
          sandbox={ARTIFACT_IFRAME_SANDBOX}
          allow={ARTIFACT_FRAME_ALLOW}
          referrerPolicy="no-referrer"
        />
      </section>
    </main>
  );
}
