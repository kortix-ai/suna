import { Button } from '@kortix/ui/button';
import { AuthFrame } from '@kortix/ui/internal/auth/auth-card-shell';
import { OutcomeTitle } from '@kortix/ui/internal/auth/auth-consent';
import { Rise, StepHeader } from '@kortix/ui/internal/auth/auth-primitives';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { KortixLogo } from '@/components/sidebar/kortix-logo';

import Link from '@/components/site-link';
import { getTranslations } from '@/i18n/get-translations';

import { SHARE_PAGE_ROOT_CLASS } from '../../session/[token]/share-layout';

import { loadPublicResponse, plainTextExcerpt } from './public-response';
import { ResponseMarkdown, SharedPrompt } from './response-markdown';

type PublicResponseRouteProps = {
  params: Promise<{ locale: string; token: string }>;
};

// A shared response is reachable by anyone with the token, and only by them:
// it must never enter a search index.
const ROBOTS: Metadata['robots'] = { index: false, follow: false };

export async function generateMetadata({ params }: PublicResponseRouteProps): Promise<Metadata> {
  const { token } = await params;
  const t = await getTranslations('turnShare');
  const result = await loadPublicResponse(token);
  if (result.kind !== 'shared') {
    return {
      title: result.kind === 'revoked' ? t('goneTitle') : t('fallbackTitle'),
      robots: ROBOTS,
    };
  }
  const title = result.response.title || t('fallbackTitle');
  const description = plainTextExcerpt(result.response.markdown);
  return {
    title,
    description,
    robots: ROBOTS,
    openGraph: { title, description, type: 'article' },
    twitter: { card: 'summary_large_image', title, description },
  };
}

export default async function PublicResponsePage({ params }: PublicResponseRouteProps) {
  const { locale, token } = await params;
  const t = await getTranslations('turnShare');
  const result = await loadPublicResponse(token);
  if (result.kind === 'missing') notFound();

  // Revoked: the quiet auth frame, the same one an unavailable session share
  // shows (share/session/[token]/page.tsx).
  if (result.kind === 'revoked') {
    return (
      <AuthFrame footerVariant="none">
        <Rise>
          <StepHeader
            title={<OutcomeTitle tone="muted">{t('goneTitle')}</OutcomeTitle>}
            description={t('goneHint')}
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

  const { response } = result;
  const title = response.title || t('fallbackTitle');
  const respondedAt = new Date(response.responded_at);
  const meta = [
    response.agent_name,
    Number.isNaN(respondedAt.getTime())
      ? null
      : new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(respondedAt),
  ].filter(Boolean);

  // Same chrome as the session share page: a bg-card canvas, the h-12 bar
  // (symbol + title left, one secondary action right), and a rounded
  // bg-background sheet below. The sheet scrolls; the bar stays.
  return (
    <main className={SHARE_PAGE_ROOT_CLASS}>
      <header className="flex h-12 shrink-0 items-center gap-3 pr-3 pl-4">
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <KortixLogo variant="symbol" size={16} className="shrink-0" />
          <h1 className="truncate text-sm font-medium">{title}</h1>
        </div>
        <Button size="sm" variant="secondary" asChild>
          <Link href="/">{t('tryKortix')}</Link>
        </Button>
      </header>
      <section className="bg-background border-border relative min-h-0 flex-1 overflow-y-auto rounded-t-md border-x border-t">
        <article className="mx-auto w-full max-w-3xl px-6 py-10">
          {meta.length > 0 ? (
            <p className="text-muted-foreground mb-6 text-xs">{meta.join(' · ')}</p>
          ) : null}
          {response.prompt ? (
            <div className="mb-6">
              <SharedPrompt text={response.prompt} />
            </div>
          ) : null}
          <ResponseMarkdown markdown={response.markdown} />
        </article>
      </section>
    </main>
  );
}
