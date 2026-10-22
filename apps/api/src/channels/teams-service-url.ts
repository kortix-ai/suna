/**
 * Allowlist of Microsoft Bot Framework / Teams service hosts that may receive
 * the bot connector token via an outbound `sendActivity`/`updateActivity` call.
 *
 * Every outbound call carries the bot connector token, so a host an outsider
 * can register must never pass. Legitimate Teams/Bot Framework service URLs are
 * always one of these suffixes. Outbound calls address a conversation by the
 * service URL inbound activities stored (install-store), never by one a caller
 * sends; this list is the chokepoint behind that.
 *
 * Extracted into its own module so callers (teams-api connectorFetch chokepoint,
 * teams/file-proxy initiateTeamsUpload) share one source of truth and unit tests
 * can exercise it without mocking the token-attaching fetch path.
 */
// No customer-registrable namespace: only the Teams connector's own Traffic
// Manager profile (any Azure customer can name a `*.trafficmanager.net`
// profile), and no `*.azurewebsites.net` (any Azure customer can register an
// app there). `azurewebsites.net` stayed on this list after the download path
// dropped it (2026-09-18), and the upload route took `service_url` from the
// request body: a caller with connector-write on any Teams-enabled project
// could have the managed bot's token sent to a host of their own.
const ALLOWED_SERVICE_HOST = /(^smba\.trafficmanager\.net|(^|\.)botframework\.com|(^|\.)botframework\.us)$/i;

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
