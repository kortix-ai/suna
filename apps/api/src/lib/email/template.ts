// The Kortix email shell. Every email the platform sends — invites, access
// requests, magic links, signup confirmations, password recovery — is rendered
// through renderEmail() so they are visibly one product rather than a branded
// invite next to a default GoTrue plain-text link.
import { escapeHtml } from '../../shared/html';
import { EMAIL_COLORS, EMAIL_FONT_MONO, EMAIL_FONT_SANS, EMAIL_LAYOUT as L } from './brand-tokens.generated';

// Colors and fonts come from the brand kit (brand-tokens.generated.ts). Rules:
// .agents/skills/kortix-brand/references/verbal/voice-and-tone.md section 5.5.
export const BRAND_FOOTER = 'Kortix — The open-source AI Management System';
// Canonical hosted logo (symbol + wordmark, black, alpha). See visual/brandmark.md.
const BRAND_LOGO_URL = L.logoUrl;

const COLOR_BG = EMAIL_COLORS.surface1;
const COLOR_CARD = EMAIL_COLORS.canvas;
const COLOR_BORDER = EMAIL_COLORS.hairline;
const COLOR_TEXT = EMAIL_COLORS.ink;
const COLOR_MUTED = EMAIL_COLORS.inkMuted;

/** Inline styles — email clients strip <style> blocks, so every rule is local. */
export const S = {
  wrapper: `margin:0;padding:0;background:${COLOR_BG};font-family:${EMAIL_FONT_SANS};`,
  outerTable: `width:100%;background:${COLOR_BG};`,
  container: `max-width:${L.containerWidth}px;margin:40px auto;background:${COLOR_CARD};border-radius:${L.cardRadius}px;border:1px solid ${COLOR_BORDER};overflow:hidden;`,
  header: `padding:28px ${L.sidePadding}px 0;text-align:center;`,
  logo: `display:inline-block;height:${L.logoHeight}px;width:auto;border:0;outline:none;text-decoration:none;`,
  body: `padding:18px ${L.sidePadding}px 36px;text-align:center;`,
  kicker: `font-size:${L.fontSize.kicker}px;font-weight:500;color:${COLOR_MUTED};margin:${L.gap.kicker_before}px 0 ${L.gap.kicker_after}px;`,
  h1: `font-size:${L.fontSize.title}px;line-height:${L.lineHeight.title};font-weight:600;color:${COLOR_TEXT};margin:0 0 ${L.gap.title_after}px;`,
  p: `font-size:${L.fontSize.body}px;line-height:${L.lineHeight.body};font-weight:400;color:${COLOR_MUTED};margin:0 0 ${L.gap.block_after}px;`,
  strong: `color:${COLOR_TEXT};font-weight:600;`,
  chipWrap: `margin:0 0 28px;`,
  chip: `display:inline-block;padding:4px 10px;border-radius:999px;border:1px solid ${COLOR_BORDER};font-size:${L.fontSize.small}px;font-weight:500;color:${COLOR_MUTED};`,
  btn: `display:inline-block;padding:${L.buttonPadding};background:${COLOR_TEXT};color:${COLOR_CARD};text-decoration:none;border-radius:${L.buttonRadius}px;font-size:${L.fontSize.body}px;font-weight:500;`,
  code: `display:inline-block;padding:12px 24px;border:1px solid ${COLOR_BORDER};border-radius:8px;font-family:${EMAIL_FONT_MONO};font-size:24px;font-weight:500;letter-spacing:0.35em;color:${COLOR_TEXT};`,
  footer: `padding:18px ${L.sidePadding}px;text-align:center;border-top:1px solid ${COLOR_BORDER};background:${COLOR_CARD};`,
  footerP: `font-size:${L.fontSize.small}px;font-weight:400;color:${COLOR_MUTED};margin:0;`,
  smallNote: `font-size:${L.fontSize.small}px;font-weight:400;color:${COLOR_MUTED};margin:24px 0 0;`,
  linkFallback: `font-size:${L.fontSize.small}px;font-weight:400;color:${COLOR_MUTED};margin:16px 0 0;word-break:break-all;`,
};

export function renderEmail(opts: { kicker?: string; title: string; body: string }): string {
  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>${escapeHtml(opts.title)}</title>
  </head>
  <body style="${S.wrapper}">
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="${S.outerTable}">
      <tr>
        <td align="center">
          <div style="${S.container}">
            <div style="${S.header}">
              <img src="${BRAND_LOGO_URL}" alt="Kortix" height="${L.logoHeight}" style="${S.logo}" />
            </div>
            <div style="${S.body}">
              ${opts.kicker ? `<div style="${S.kicker}">${escapeHtml(opts.kicker)}</div>` : ''}
              <h1 style="${S.h1}">${escapeHtml(opts.title)}</h1>
              ${opts.body}
            </div>
            <div style="${S.footer}">
              <p style="${S.footerP}">${BRAND_FOOTER}</p>
            </div>
          </div>
        </td>
      </tr>
    </table>
  </body>
</html>`.trim();
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

/** Primary call-to-action button plus the copy/paste fallback link beneath it. */
export function actionButton(url: string, label: string): string {
  return `
    <a href="${escapeHtml(url)}" style="${S.btn}">${escapeHtml(label)}</a>
    <p style="${S.linkFallback}">
      Or paste this link into your browser:<br />${escapeHtml(url)}
    </p>
  `;
}
