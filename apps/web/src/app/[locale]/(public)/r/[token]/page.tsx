import { Button } from '@kortix/ui/button';
import { EmptyState } from '@kortix/ui/empty-state';
import { KortixLogo } from '@kortix/ui/kortix-logo';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';

import Link from '@/components/site-link';
import { getTranslations } from '@/i18n/get-translations';

import { loadPublicResponse, plainTextExcerpt } from './public-response';
import { ResponseMarkdown } from './response-markdown';

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

/** The calm reading column every state of this page shares. */
function ReadingShell({ children, footer }: { children: ReactNode; footer?: ReactNode }) {
  return (
    <main className="bg-background text-foreground min-h-dvh">
      <div className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col gap-16 px-4 py-10">
        <header>
          <Link href="/" aria-label="Kortix" className="inline-flex">
            <KortixLogo variant="brandmark" size={15} />
          </Link>
        </header>
        <div className="flex-1">{children}</div>
        {footer}
      </div>
    </main>
  );
}

export default async function PublicResponsePage({ params }: PublicResponseRouteProps) {
  const { locale, token } = await params;
  const t = await getTranslations('turnShare');
  const result = await loadPublicResponse(token);
  if (result.kind === 'missing') notFound();

  const tryKortix = (
    <Button asChild variant="secondary" size="sm">
      <Link href="/">{t('tryKortix')}</Link>
    </Button>
  );

  if (result.kind === 'revoked') {
    return (
      <ReadingShell>
        <div className="flex h-full items-center justify-center py-8">
          <EmptyState size="sm" title={t('goneTitle')} description={t('goneHint')} action={tryKortix} />
        </div>
      </ReadingShell>
    );
  }

  const { response } = result;
  const respondedAt = new Date(response.responded_at);
  const meta = [
    t('sharedFrom'),
    response.agent_name,
    Number.isNaN(respondedAt.getTime())
      ? null
      : new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(respondedAt),
  ].filter(Boolean);

  return (
    <ReadingShell footer={<footer className="border-t pt-6">{tryKortix}</footer>}>
      <article className="space-y-8">
        <header className="space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight text-balance">
            {response.title || t('fallbackTitle')}
          </h1>
          <p className="text-muted-foreground text-xs">{meta.join(' · ')}</p>
        </header>
        <ResponseMarkdown markdown={response.markdown} />
      </article>
    </ReadingShell>
  );
}
