/**
 * Allowlist of Microsoft Bot Framework / Teams service hosts that may receive
 * the bot connector token via an outbound `sendActivity`/`updateActivity` call.
 *
 * The `serviceUrl` on the outbound path is partially caller-influenced (the
 * file-upload route accepts it from the request body), so we must not let an
 * attacker point the bot connector token at an arbitrary host. Legitimate
 * Teams/Bot Framework service URLs are always one of these suffixes.
 *
 * Extracted into its own module so callers (teams-api connectorFetch chokepoint,
 * teams/file-proxy initiateTeamsUpload) share one source of truth and unit tests
 * can exercise it without mocking the token-attaching fetch path.
 */
// Only the Teams connector's own Traffic Manager profile: `*.trafficmanager.net`
// profile names are registrable by any Azure customer.
const ALLOWED_SERVICE_HOST =
  /(^smba\.trafficmanager\.net|(^|\.)botframework\.com|(^|\.)botframework\.us|(^|\.)azurewebsites\.net)$/i;

/**
 * Returns the validated, https service URL, or `null` if the host is not a
 * trusted Microsoft Bot Framework endpoint. Callers that attach the bot
 * connector token MUST gate on this before `fetch`.
 */
export function assertValidTeamsServiceUrl(url: string): URL | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || !ALLOWED_SERVICE_HOST.test(parsed.hostname)) {
    return null;
  }
  return parsed;
}
