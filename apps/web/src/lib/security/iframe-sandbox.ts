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

const PRESENTATION_IFRAME_SANDBOX_TOKENS = [
  'allow-same-origin',
  'allow-scripts',
] as const;

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

export const TERMINAL_IFRAME_SANDBOX = joinSandboxTokens(
  TERMINAL_IFRAME_SANDBOX_TOKENS,
);

export const PRESENTATION_IFRAME_SANDBOX = joinSandboxTokens(
  PRESENTATION_IFRAME_SANDBOX_TOKENS,
);

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
