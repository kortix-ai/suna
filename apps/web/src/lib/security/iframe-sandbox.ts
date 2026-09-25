const INTERACTIVE_PREVIEW_IFRAME_SANDBOX_TOKENS = [
  'allow-same-origin',
  'allow-scripts',
  'allow-forms',
  'allow-popups',
  'allow-downloads',
  'allow-modals',
] as const;

const ISOLATED_HTML_PREVIEW_IFRAME_SANDBOX_TOKENS = [
  'allow-scripts',
  'allow-forms',
  'allow-popups',
  'allow-downloads',
] as const;

const TERMINAL_IFRAME_SANDBOX_TOKENS = [
  'allow-scripts',
  'allow-same-origin',
  'allow-forms',
  'allow-popups',
] as const;

const PRESENTATION_IFRAME_SANDBOX_TOKENS = ['allow-same-origin', 'allow-scripts'] as const;

const PRESENTATION_WITH_MODALS_IFRAME_SANDBOX_TOKENS = [
  'allow-same-origin',
  'allow-scripts',
  'allow-modals',
] as const;

function joinSandboxTokens(tokens: readonly string[]): string {
  return tokens.join(' ');
}

export const INTERACTIVE_PREVIEW_IFRAME_SANDBOX = joinSandboxTokens(
  INTERACTIVE_PREVIEW_IFRAME_SANDBOX_TOKENS,
);

export const ISOLATED_HTML_PREVIEW_IFRAME_SANDBOX = joinSandboxTokens(
  ISOLATED_HTML_PREVIEW_IFRAME_SANDBOX_TOKENS,
);

export const TERMINAL_IFRAME_SANDBOX = joinSandboxTokens(TERMINAL_IFRAME_SANDBOX_TOKENS);

export const PRESENTATION_IFRAME_SANDBOX = joinSandboxTokens(PRESENTATION_IFRAME_SANDBOX_TOKENS);

export const PRESENTATION_WITH_MODALS_IFRAME_SANDBOX = joinSandboxTokens(
  PRESENTATION_WITH_MODALS_IFRAME_SANDBOX_TOKENS,
);

export const CLIPBOARD_IFRAME_ALLOW = 'clipboard-read; clipboard-write';

export const YOUTUBE_IFRAME_ALLOW =
  'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture';

export function getIframeSandbox(options?: { isolateHtmlPreview?: boolean }): string {
  if (options?.isolateHtmlPreview) {
    return ISOLATED_HTML_PREVIEW_IFRAME_SANDBOX;
  }

  return INTERACTIVE_PREVIEW_IFRAME_SANDBOX;
}

/**
 * The sandbox for a frame whose document an agent wrote: the `show` card and
 * deck slides.
 *
 * `allow-same-origin` is granted only when the frame has an origin of its own
 * (a per-sandbox preview host). When the frame URL resolves to one of
 * `privilegedOrigins` — this app, or the API that serves the path proxy
 * `/v1/p/<sandbox>/<port>/…` — the frame runs with an opaque origin instead,
 * the same policy `HtmlPreview` applies. It then cannot read this app's
 * storage or send requests with the viewer's cookies for that origin. A URL
 * that does not parse is treated as privileged.
 */
export function getAgentContentIframeSandbox(
  frameSrc: string,
  options: {
    /** Origins (or URLs on them) that must never share an origin with agent content. */
    privilegedOrigins: readonly string[];
    /** Base for a relative `frameSrc`. Defaults to the first privileged origin. */
    baseUrl?: string;
    /** Deck slides: scripts and modals only. */
    presentation?: boolean;
  },
): string {
  const sharedOrigin = isOnPrivilegedOrigin(frameSrc, options);
  if (options.presentation) {
    const tokens = sharedOrigin
      ? PRESENTATION_WITH_MODALS_IFRAME_SANDBOX_TOKENS.filter((t) => t !== 'allow-same-origin')
      : PRESENTATION_WITH_MODALS_IFRAME_SANDBOX_TOKENS;
    return joinSandboxTokens(tokens);
  }
  return sharedOrigin ? ISOLATED_HTML_PREVIEW_IFRAME_SANDBOX : INTERACTIVE_PREVIEW_IFRAME_SANDBOX;
}

function originOf(value: string, base?: string): string | null {
  try {
    const url = base ? new URL(value, base) : new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

function isOnPrivilegedOrigin(
  frameSrc: string,
  options: { privilegedOrigins: readonly string[]; baseUrl?: string },
): boolean {
  const privileged = options.privilegedOrigins
    .map((origin) => originOf(origin))
    .filter((origin): origin is string => origin !== null);
  const base = options.baseUrl ?? privileged[0];
  const frameOrigin = originOf(frameSrc, base);
  if (!frameOrigin) return true;
  return privileged.includes(frameOrigin);
}
