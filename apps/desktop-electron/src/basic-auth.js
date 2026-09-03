// HTTP Basic credential policy for the Kortix desktop shell — pure, no Electron.
//
// Dev and staging sit behind one shared HTTP Basic credential
// (apps/web/src/middleware.ts answers 401 "Authentication required."). Chrome
// pops its own username/password dialog for that; Electron does not, so the
// shell has to decide, per challenge, whether to answer silently or ask the
// user. That decision lives here so it can be unit-tested without a window.
//
// Sources, in precedence order:
//   1. KORTIX_DESKTOP_BASIC_PASSWORD env (CI / scripted launches)
//   2. a credential the user entered earlier for this host (memory, and on
//      disk via safeStorage when the user ticked "Remember")
//   3. a dialog
//
// Rejection detection: Chromium re-issues the `login` event for the same URL
// when the server answers 401 to the credential we supplied. There is no
// explicit "rejected" signal, so a second challenge for the same host within
// REJECT_WINDOW_MS of our last answer is treated as "that credential was
// wrong" — the stored copy is dropped and the dialog opens with an error.

const REJECT_WINDOW_MS = 60_000;
const DEFAULT_USER = 'kortix';

/**
 * Decide how to answer one Basic challenge.
 *
 * @param {object} input
 * @param {string} input.host           challenge host (already origin-checked)
 * @param {{ user?: string, password?: string }} [input.env]
 *   KORTIX_DESKTOP_BASIC_USER / KORTIX_DESKTOP_BASIC_PASSWORD
 * @param {{ user: string, password: string } | null} [input.stored]
 *   credential remembered for this host
 * @param {{ source: 'env'|'stored'|'prompt', at: number } | null} [input.lastAnswer]
 *   what we last sent for this host, and when
 * @param {number} input.now
 * @returns {
 *   | { action: 'answer', source: 'env'|'stored', user: string, password: string }
 *   | { action: 'prompt', user: string, error: string | null, dropStored: boolean }
 * }
 */
function decideChallenge({ host, env, stored, lastAnswer, now }) {
  const rejected =
    !!lastAnswer && typeof lastAnswer.at === 'number' && now - lastAnswer.at < REJECT_WINDOW_MS;

  if (env && env.password && !(rejected && lastAnswer.source === 'env')) {
    return {
      action: 'answer',
      source: 'env',
      user: env.user || DEFAULT_USER,
      password: env.password,
    };
  }

  // A credential typed into the dialog becomes the stored one, so a rejected
  // 'prompt' answer means the stored copy is wrong too — never retry it.
  const storedRejected = rejected && lastAnswer.source !== 'env';
  if (stored && stored.password && !storedRejected) {
    return { action: 'answer', source: 'stored', user: stored.user || DEFAULT_USER, password: stored.password };
  }

  // Everything silent has been tried (or was just rejected) — ask the user.
  const prefillUser =
    (rejected && stored && stored.user) || (env && env.user) || (stored && stored.user) || DEFAULT_USER;
  return {
    action: 'prompt',
    user: prefillUser,
    error: rejected ? `${host} rejected the username or password.` : null,
    // A stored credential that was just rejected must not be retried silently
    // on the next launch.
    dropStored: storedRejected && !!stored,
  };
}

/* ─── On-disk store (host → { user, secret }) ───────────────────────────────
   `secret` is opaque here: the caller encrypts with safeStorage before
   `upsertHost` and decrypts after `lookupHost`. Only the JSON shape is owned by
   this module. */

const STORE_VERSION = 1;

function emptyStore() {
  return { version: STORE_VERSION, hosts: {} };
}

/** @param {string | null | undefined} raw file contents */
function parseStore(raw) {
  if (!raw) return emptyStore();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return emptyStore();
  }
  if (!data || data.version !== STORE_VERSION || typeof data.hosts !== 'object' || !data.hosts) {
    return emptyStore();
  }
  const hosts = {};
  for (const [host, entry] of Object.entries(data.hosts)) {
    if (entry && typeof entry.user === 'string' && typeof entry.secret === 'string') {
      hosts[host] = { user: entry.user, secret: entry.secret };
    }
  }
  return { version: STORE_VERSION, hosts };
}

function serializeStore(store) {
  return JSON.stringify({ version: STORE_VERSION, hosts: store.hosts }, null, 2) + '\n';
}

function lookupHost(store, host) {
  return store.hosts[host] || null;
}

function upsertHost(store, host, entry) {
  return {
    version: STORE_VERSION,
    hosts: { ...store.hosts, [host]: { user: entry.user, secret: entry.secret } },
  };
}

function removeHost(store, host) {
  const hosts = { ...store.hosts };
  delete hosts[host];
  return { version: STORE_VERSION, hosts };
}

module.exports = {
  DEFAULT_USER,
  REJECT_WINDOW_MS,
  decideChallenge,
  parseStore,
  serializeStore,
  lookupHost,
  upsertHost,
  removeHost,
};
