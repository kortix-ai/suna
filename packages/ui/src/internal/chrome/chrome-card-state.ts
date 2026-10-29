/**
 * Which call to action the Chrome card shows. Pure, so the three states
 * (not installed, installed, connected) are testable without a browser.
 */
export type ChromeCardState = 'connected' | 'unsupported' | 'checking' | 'installed' | 'notInstalled';

export function chromeCardState(input: {
  /** THIS browser is connected. Other connected browsers do not count. */
  thisBrowserConnected: boolean;
  /** `unsupported`: Safari, Firefox, the desktop shell. */
  environment: 'checking' | 'supported' | 'unsupported';
  /** The first ping has not answered yet. */
  checking: boolean;
  /** The extension answered a ping, or a browser connected. */
  installed: boolean;
}): ChromeCardState {
  if (input.thisBrowserConnected) return 'connected';
  if (input.environment === 'unsupported') return 'unsupported';
  if (input.checking) return 'checking';
  return input.installed ? 'installed' : 'notInstalled';
}
