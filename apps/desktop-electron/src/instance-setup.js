// Kortix instance choice for the desktop shell — pure, no Electron.
//
// On the first launch of a new profile the shell asks which Kortix instance to
// connect to: Kortix Cloud (the URL baked in at build time) or a self-hosted
// URL. The same chooser backs Frontend URL → Custom URL… and the recovery
// screen after the app origin fails to load. Every decision the chooser makes
// lives here so it can be unit-tested without a window.
//
// Persistence contract (owned by main.js):
//   userData/frontend_url            the chosen self-hosted URL (absent = default)
//   userData/instance_setup_pending  written for a new profile; removed once the
//                                    user chooses, so quitting the chooser asks again

const SETUP_PENDING_FILE = 'instance_setup_pending';
const PROBE_TIMEOUT_MS = 8_000;

// Written by the OS into any directory Finder has shown; never app state.
const IGNORED_PROFILE_ENTRIES = new Set(['.DS_Store']);

const LOOPBACK_HOST = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$|\.localhost$/;

/**
 * Turn what the user typed into the URL the window loads.
 *
 * @param {unknown} raw
 * @returns {{ ok: true, url: string } | { ok: false, error: string }}
 */
function normalizeInstanceUrl(raw) {
  const input = typeof raw === 'string' ? raw.trim() : '';
  if (!input) return { ok: false, error: 'Enter the URL of your Kortix instance.' };

  // `localhost:3000` parses as the scheme `localhost:`. A host:port prefix is a
  // bare host, not a scheme.
  const isHostPort = /^[^\s/:]+:\d+(?:[/?#]|$)/.test(input);
  const hasScheme = !isHostPort && /^[a-z][a-z0-9+.-]*:/i.test(input);
  let candidate = input;
  if (!hasScheme) {
    const bareHost = input.startsWith('[')
      ? input.slice(0, input.indexOf(']') + 1)
      : input.split(/[/:?#]/)[0];
    candidate = `${LOOPBACK_HOST.test(bareHost.toLowerCase()) ? 'http' : 'https'}://${input}`;
  }

  let url;
  try {
    url = new URL(candidate);
  } catch {
    return { ok: false, error: 'This is not a valid URL.' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, error: 'The URL must start with http:// or https://.' };
  }
  if (url.username || url.password) {
    return { ok: false, error: 'Remove the username and password from the URL.' };
  }
  if (!url.hostname) return { ok: false, error: 'This is not a valid URL.' };

  url.search = '';
  url.hash = '';
  // Same landing path as the Production / Dev / Local presets.
  if (url.pathname === '/') url.pathname = '/projects';
  return { ok: true, url: url.toString() };
}

/**
 * Is this a profile no earlier launch has used? Checked before anything in the
 * process writes into userData (the single-instance lock creates SingletonLock).
 *
 * @param {string[] | null} entries directory listing; null when the directory is missing
 */
function isFreshProfile(entries) {
  if (!entries) return true;
  return entries.every((name) => IGNORED_PROFILE_ENTRIES.has(name));
}

/**
 * @param {{ pending: boolean, override?: string | null, envUrl?: string }} input
 */
function needsInstanceSetup({ pending, override, envUrl }) {
  return Boolean(pending) && !override && !envUrl;
}

/** Label for the "use the default" option. */
function describeDefaultInstance(defaultUrl) {
  let parsed;
  try {
    parsed = new URL(defaultUrl);
  } catch {
    return { title: 'Default', host: String(defaultUrl) };
  }
  const isCloud = parsed.hostname === 'kortix.com' || parsed.hostname.endsWith('.kortix.com');
  return { title: isCloud ? 'Kortix Cloud' : 'Default', host: parsed.host };
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return String(url);
  }
}

/**
 * One sentence for a Chromium network error. `raw` is a did-fail-load
 * description (`ERR_NAME_NOT_RESOLVED`) or a net.fetch message
 * (`net::ERR_NAME_NOT_RESOLVED`).
 */
function explainNetError(host, raw) {
  const code = /ERR_[A-Z0-9_]+/.exec(String(raw || ''))?.[0];
  if (!code) return `${host} did not load.`;
  if (code.startsWith('ERR_CERT_')) return `The security certificate of ${host} is not trusted.`;
  switch (code) {
    case 'ERR_NAME_NOT_RESOLVED':
    case 'ERR_NAME_RESOLUTION_FAILED':
      return `${host} could not be found. Check the address.`;
    case 'ERR_CONNECTION_REFUSED':
      return `${host} refused the connection.`;
    case 'ERR_INTERNET_DISCONNECTED':
      return 'This computer is offline.';
    case 'ERR_CONNECTION_TIMED_OUT':
    case 'ERR_TIMED_OUT':
      return `${host} took too long to respond.`;
    case 'ERR_ADDRESS_UNREACHABLE':
      return `${host} cannot be reached from this network.`;
    case 'ERR_CONNECTION_RESET':
    case 'ERR_CONNECTION_CLOSED':
      return `${host} closed the connection.`;
    case 'ERR_SSL_PROTOCOL_ERROR':
    case 'ERR_SSL_VERSION_OR_CIPHER_MISMATCH':
      return `${host} does not accept a secure connection. Try http:// instead.`;
    default:
      return `${host} did not load (${code}).`;
  }
}

/**
 * Can this machine reach the instance? Any HTTP status counts: a self-hosted
 * instance behind HTTP Basic answers 401, and that is still the right server.
 * Only a network failure or a timeout is "unreachable".
 *
 * @param {string} url normalized instance URL
 * @param {{ fetch: (url: string, init: object) => Promise<{ status: number }>, timeoutMs?: number }} deps
 * @returns {Promise<{ ok: true, status: number } | { ok: false, error: string }>}
 */
async function probeInstance(url, { fetch, timeoutMs = PROBE_TIMEOUT_MS }) {
  const host = hostOf(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      // Never send the user's cookies or answer an auth challenge from a probe.
      credentials: 'omit',
      signal: controller.signal,
    });
    return { ok: true, status: res.status };
  } catch (e) {
    if (controller.signal.aborted) {
      return { ok: false, error: `${host} did not respond within ${Math.max(1, Math.ceil(timeoutMs / 1000))} s.` };
    }
    return { ok: false, error: explainNetError(host, e && e.message) };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  SETUP_PENDING_FILE,
  PROBE_TIMEOUT_MS,
  normalizeInstanceUrl,
  isFreshProfile,
  needsInstanceSetup,
  describeDefaultInstance,
  hostOf,
  explainNetError,
  probeInstance,
};
