// The Kortix email shell. Every email the platform sends — invites, access
// requests, magic links, signup confirmations, password recovery — is rendered
// through renderEmail() so they are visibly one product rather than a branded
// invite next to a default GoTrue plain-text link.
//
// The frame is the React Email demo template 01-Barebone, built from
// @react-email/components: a grey page, a white frame with a header row
// (the symbol only, no label), one grey card, and a white footer. Two edges:
// the header sits on the frame edge and the footer is centered; every block inside the card
// sits on one left edge, 40 px in.
import { Body, Button, Container, Head, Heading, Html, Img, Link, Preview, Section, Text } from '@react-email/components';
import type { CSSProperties } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { config } from '../../config';
import { EMAIL_COLORS as C, EMAIL_FONT_SANS, EMAIL_LAYOUT as L } from './brand-tokens.generated';

// Colors and fonts come from the brand kit (brand-tokens.generated.ts). Rules:
// .agents/skills/kortix-brand/references/verbal/voice-and-tone.md section 5.5.
export const BRAND_FOOTER = 'Kortix CompanyOS – the open-source operating system for your company';
// The Brandmark PNG (the symbol) is 2000 x 1708. Outlook desktop ignores CSS
// sizes and draws an <img> at its attribute size, so both attributes are set.
const LOGO_HEIGHT = Math.round((L.logoWidth * 1708) / 2000);

const T = L.fontSize;
const W = L.fontWeight;
const sans = `font-family:${EMAIL_FONT_SANS};`;

/** Inline styles — email clients strip <style> blocks, so every rule is local. */
export const S = {
  /** A small muted label above a value (the digest row kind). */
  kicker: `${sans}font-size:${T.label}px;line-height:${L.lineHeight.label};font-weight:${W.body};color:${C.inkMuted};margin:0;`,
  p: `${sans}font-size:${T.body}px;line-height:${L.lineHeight.body};font-weight:${W.body};color:${C.inkMuted};margin:0 0 ${L.gap.block_after}px;text-align:left;text-wrap:pretty;`,
  strong: `color:${C.ink};font-weight:${W.strong};`,
  chipWrap: `margin:0 0 ${L.gap.block_after}px;text-align:left;`,
  chip: `display:inline-block;padding:2px 10px;border-radius:999px;border:1px solid ${C.hairline};background:${C.canvas};${sans}font-size:${T.small}px;line-height:${L.lineHeight.label};font-weight:${W.strong};color:${C.ink};`,
  /** A one-time code: the sans face with tabular digits, never the mono face. */
  code: `display:inline-block;padding:12px 20px;border-radius:${L.buttonRadius}px;background:${C.canvas};border:1px solid ${C.hairline};${sans}font-size:${T.title + 4}px;line-height:1.2;font-weight:${W.title};letter-spacing:4px;font-variant-numeric:tabular-nums;color:${C.ink};`,
  /** A list row on the grey card, such as one notification in the digest. */
  row: `background:${C.canvas};border-radius:${L.cardRadius}px;padding:16px 20px;margin:0 0 8px;text-align:left;${sans}font-size:${T.body}px;line-height:${L.lineHeight.label};`,
  smallNote: `${sans}font-size:${T.label}px;line-height:${L.lineHeight.label};font-weight:${W.body};color:${C.inkMuted};margin:${L.gap.note_before}px 0 0;text-align:left;text-wrap:pretty;`,
};

/** The Barebone `mobile:` variants. Clients that drop <style> keep the desktop layout. */
const MOBILE_CSS = `@media (max-width:600px){.k-page{margin-top:0!important}.k-frame{padding:${L.mobileFramePadding}!important}.k-card{padding:${L.mobileCardPadding}!important}}`;

const small = { margin: 0, color: C.inkMuted, fontFamily: EMAIL_FONT_SANS, fontSize: T.small, lineHeight: L.lineHeight.label, textAlign: 'center' } satisfies CSSProperties;

const st = {
  body: { backgroundColor: C.surface1, margin: 0, textAlign: 'left', fontFamily: EMAIL_FONT_SANS },
  page: { margin: '32px auto 0', width: '100%', maxWidth: L.containerWidth },
  frame: { backgroundColor: C.canvas, padding: L.framePadding },
  header: { padding: '8px 0', marginBottom: 16 },
  card: { backgroundColor: C.surface1, borderRadius: L.cardRadius, padding: L.cardPadding, textAlign: 'left' },
  h1: { margin: `0 0 ${L.gap.title_after}px`, color: C.ink, fontFamily: EMAIL_FONT_SANS, fontSize: T.title, lineHeight: L.lineHeight.title, fontWeight: W.title, letterSpacing: L.letterSpacing.title, textAlign: 'left', textWrap: 'balance' },
  footer: { padding: '32px 0 16px', textAlign: 'center' },
  slogan: { ...small, fontSize: T.label, margin: '0 0 16px' },
  socialLink: { display: 'inline-block', padding: '0 8px', verticalAlign: 'middle' },
  small,
  smallLink: { color: C.inkMuted, textDecoration: 'underline' },
  button: { display: 'inline-block', backgroundColor: C.ink, color: C.canvas, padding: L.buttonPadding, borderRadius: L.buttonRadius, fontFamily: EMAIL_FONT_SANS, fontSize: T.body, lineHeight: '20px', fontWeight: W.strong, textDecoration: 'none', textAlign: 'center' },
} satisfies Record<string, CSSProperties>;

// Social icons are served by the web app (apps/web/public/email), so a
// self-hosted deployment links its own host.
const SOCIALS = [
  { href: 'https://x.com/kortix', icon: 'social-x.png', alt: 'X' },
  { href: 'https://linkedin.com/company/kortix', icon: 'social-linkedin.png', alt: 'LinkedIn' },
  { href: 'https://github.com/kortix-ai/suna', icon: 'social-github.png', alt: 'GitHub' },
];

function Shell(props: { title: string; body: string; preview: string }) {
  const site = (config.FRONTEND_URL || 'http://localhost:3000').replace(/\/+$/, '');
  return (
    <Html lang="en">
      <Head>
        <meta name="x-apple-disable-message-reformatting" />
        <meta name="format-detection" content="telephone=no,date=no,address=no,email=no,url=no" />
        <title>{props.title}</title>
        <style>{MOBILE_CSS}</style>
      </Head>
      <Body style={st.body}>
        <Preview>{props.preview}</Preview>
        <Container className="k-page" style={st.page}>
          <Section className="k-frame" style={st.frame}>
            <Section style={st.header}>
              <Img src={L.logoUrl} alt="Kortix" width={L.logoWidth} height={LOGO_HEIGHT} style={{ display: 'block' }} />
            </Section>

            <Section className="k-card" style={st.card}>
              <Heading as="h1" style={st.h1}>
                {props.title}
              </Heading>
              <div dangerouslySetInnerHTML={{ __html: props.body }} />
            </Section>

            <Section style={st.footer}>
              <Text style={st.slogan}>{BRAND_FOOTER}</Text>
              <Section style={{ marginBottom: 16, textAlign: 'center' }}>
                {SOCIALS.map((s) => (
                  <Link key={s.alt} href={s.href} style={st.socialLink}>
                    <Img src={`${site}/email/${s.icon}`} alt={s.alt} width={16} height={16} style={{ display: 'block' }} />
                  </Link>
                ))}
              </Section>
              <Text style={st.small}>
                <Link href="https://kortix.com" style={st.smallLink}>
                  kortix.com
                </Link>
              </Text>
            </Section>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}

export function renderEmail(opts: { title: string; body: string; preview?: string }): string {
  // ponytail: sync react-dom render; React Email's async render() adds only pretty-printing.
  return `<!DOCTYPE html>${renderToStaticMarkup(<Shell {...opts} preview={opts.preview ?? opts.title} />)}`;
}

/**
 * Plain-text alternative, built from the SAME structured content as the HTML.
 *
 * Deliberately not derived by stripping tags out of the rendered HTML: a
 * regex tag-stripper is both fragile (CodeQL js/bad-tag-filter,
 * js/incomplete-multi-character-sanitization, js/double-escaping all landed on
 * exactly that) and pointless here, because every caller already holds the
 * structured content the HTML was built from.
 */
export function renderText(opts: {
  title: string;
  paragraphs: string[];
  cta?: { url: string; label: string };
  code?: string;
  note?: string;
}): string {
  const lines = [opts.title, ''];
  for (const paragraph of opts.paragraphs) lines.push(paragraph, '');
  if (opts.code) lines.push(opts.code, '');
  if (opts.cta) lines.push(`${opts.cta.label}: ${opts.cta.url}`, '');
  if (opts.note) lines.push(opts.note, '');
  lines.push(BRAND_FOOTER);
  return lines.join('\n').trim();
}

/** Primary call-to-action, on the card's left edge (React Email adds the Outlook padding). */
export function actionButton(url: string, label: string): string {
  return renderToStaticMarkup(
    <Section style={{ padding: `${L.gap.button_before}px 0 ${L.gap.block_after}px`, textAlign: 'left' }}>
      <Button href={url} style={st.button}>
        {label}
      </Button>
    </Section>,
  );
}
