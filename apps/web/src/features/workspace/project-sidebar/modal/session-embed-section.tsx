'use client';

import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { errorToast, successToast } from '@/components/ui/toast';
import { useTranslations } from '@/i18n/use-translations';
import { CheckIcon, CodeIcon } from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';

/**
 * The iframe snippet a host page pastes: the ACTUAL session page
 * (`/projects/:projectId/sessions/:sessionId`), not a separate widget or
 * viewer. Pure, so the test can pin the exact HTML without a browser.
 *
 * The snippet is static HTML by construction: the URL is built from ids, and
 * the `title` attribute is a fixed string. Never interpolate a session title
 * into the attribute — an unescaped quote would break out of it on the HOST
 * page, which does not share this app's CSP.
 */
export function sessionEmbedSnippet(projectId: string, sessionId: string, origin: string): string | null {
  if (!projectId || !sessionId || !origin) return null;
  const src = `${origin}/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}`;
  return `<iframe src="${src}" style="height:640px;width:100%;border:0;border-radius:12px" title="Kortix session" loading="lazy"></iframe>`;
}

/**
 * "Embed" in the Share dialog: one copy button for the iframe snippet above.
 * Framing the session page is allowed by the CSP `frame-ancestors` rule on
 * that route (next.config.ts); the viewer inside the frame is the app's own
 * auth. Same-site embeds require an existing signed-in session; cross-site
 * embeds cannot sign in inside the frame (SameSite=Lax and /auth's CSP).
 *
 * Mounted inside `ModalContent`, so `window` is read at render time of an open
 * dialog, never during SSR.
 */
export function SessionEmbedSection({
  projectId,
  sessionId,
}: {
  projectId: string;
  sessionId: string;
}) {
  const t = useTranslations('hardcodedUi.sessionEmbed');
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    };
  }, []);

  const origin = typeof window === 'undefined' ? null : window.location.origin;
  const snippet = origin ? sessionEmbedSnippet(projectId, sessionId, origin) : null;

  const copy = async () => {
    if (!snippet) return;
    try {
      await navigator.clipboard.writeText(snippet);
      if (!mounted.current) return;
      setCopied(true);
      successToast(t('copied'));
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      if (!mounted.current) return;
      errorToast(tI18nComplete.raw('text167c96824acb'));
    }
  };

  return (
    <section className="space-y-2" data-testid="session-embed">
      <div className="space-y-1">
        <Label>{t('sectionTitle')}</Label>
        <p className="text-muted-foreground text-xs">{t('sectionDescription')}</p>
      </div>
      <Button variant="outline" size="sm" disabled={!snippet} onClick={copy}>
        {copied ? (
          <CheckIcon className="text-kortix-green size-4 shrink-0" />
        ) : (
          <CodeIcon className="size-4 shrink-0" />
        )}
        {t('copy')}
      </Button>
    </section>
  );
}
