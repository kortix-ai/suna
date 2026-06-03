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

const ISOLATED_HTML_PREVIEW_IFRAME_SANDBOX = joinSandboxTokens(
  ISOLATED_HTML_PREVIEW_IFRAME_SANDBOX_TOKENS,
);

export const PRESENTATION_WITH_MODALS_IFRAME_SANDBOX = joinSandboxTokens(
  PRESENTATION_WITH_MODALS_IFRAME_SANDBOX_TOKENS,
);

export function getIframeSandbox(options?: { isolateHtmlPreview?: boolean }): string {
  if (options?.isolateHtmlPreview) {
    return ISOLATED_HTML_PREVIEW_IFRAME_SANDBOX;
  }

  return INTERACTIVE_PREVIEW_IFRAME_SANDBOX;
}
