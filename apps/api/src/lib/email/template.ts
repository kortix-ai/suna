// The Kortix email shell. Every email the platform sends — invites, access
// requests, magic links, signup confirmations, password recovery — is rendered
// through renderEmail() so they are visibly one product rather than a branded
// invite next to a default GoTrue plain-text link.
const BRAND_WORDMARK = 'Kortix';
const BRAND_FOOTER = 'Kortix — The Autonomous Company Operating System';

const COLOR_BG = '#f6f7f9';
const COLOR_CARD = '#ffffff';
const COLOR_BORDER = '#e5e7eb';
const COLOR_TEXT = '#111111';
const COLOR_MUTED = '#6b7280';
const COLOR_ACCENT = '#111111';

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Inline styles — email clients strip <style> blocks, so every rule is local. */
export const S = {
  wrapper: `margin:0;padding:0;background:${COLOR_BG};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;`,
  outerTable: `width:100%;background:${COLOR_BG};`,
  container: `max-width:520px;margin:40px auto;background:${COLOR_CARD};border-radius:14px;border:1px solid ${COLOR_BORDER};overflow:hidden;`,
  header: `padding:28px 32px 0;text-align:center;`,
  wordmark: `font-size:15px;font-weight:700;letter-spacing:0.5px;color:${COLOR_TEXT};margin:0;`,
  body: `padding:18px 32px 36px;text-align:center;`,
  kicker: `font-size:11px;color:${COLOR_MUTED};letter-spacing:0.2em;text-transform:uppercase;margin:24px 0 8px;`,
  h1: `font-size:22px;line-height:1.25;font-weight:600;color:${COLOR_TEXT};margin:0 0 12px;`,
  p: `font-size:14px;line-height:1.6;color:${COLOR_MUTED};margin:0 0 24px;`,
  strong: `color:${COLOR_TEXT};font-weight:600;`,
  chipWrap: `margin:0 0 28px;`,
  chip: `display:inline-block;padding:4px 10px;border-radius:999px;border:1px solid ${COLOR_BORDER};font-size:11px;color:${COLOR_MUTED};letter-spacing:0.06em;text-transform:uppercase;`,
  btn: `display:inline-block;padding:12px 28px;background:${COLOR_ACCENT};color:#ffffff;text-decoration:none;border-radius:10px;font-size:14px;font-weight:500;`,
  code: `display:inline-block;padding:12px 24px;border:1px solid ${COLOR_BORDER};border-radius:10px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:24px;letter-spacing:0.35em;color:${COLOR_TEXT};`,
  footer: `padding:18px 32px;text-align:center;border-top:1px solid ${COLOR_BORDER};background:${COLOR_CARD};`,
  footerP: `font-size:12px;color:#9ca3af;margin:0;`,
  smallNote: `font-size:12px;color:${COLOR_MUTED};margin:24px 0 0;`,
  linkFallback: `font-size:12px;color:${COLOR_MUTED};margin:16px 0 0;word-break:break-all;`,
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
              <p style="${S.wordmark}">${BRAND_WORDMARK}</p>
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
