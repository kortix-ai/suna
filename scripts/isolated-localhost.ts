// Bun test preload: keep `localhost` reachable on a locked-down runtime.
//
// On a locked-down runtime the hosts file is not readable by the test user, so
// name resolution of `localhost` fails before any dial — `fetch('http://localhost:…')`
// answers "Unable to connect" even for a server this same process just bound,
// and every suite that stubs an upstream on localhost fails for the wrong
// reason (2026-10-03: 17 kortixd tests, the API marketplace and platinum
// contracts, the flow-runner unit lane — all green on dev and CI).
//
// Rewrite loopback names to the loopback address for this test process only,
// and only when the hosts file really cannot serve the name. A developer box
// or CI resolves normally and keeps resolving `localhost` as itself; the vetting
// and Host-header logic upstream of `fetch` is unaffected.
import { accessSync, constants, readFileSync } from 'node:fs'

function hostsFileServesLocalhost(): boolean {
  try {
    accessSync('/etc/hosts', constants.R_OK)
    return /^localhost\s/im.test(readFileSync('/etc/hosts', 'utf8'))
  } catch {
    return false
  }
}

if (!hostsFileServesLocalhost()) {
  const realFetch = globalThis.fetch
  const rewrite = (url: string): string =>
    url.replace(/^(https?:\/\/)localhost(?=[/:?#]|$)/i, '$1127.0.0.1')
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    if (typeof input === 'string') return realFetch(rewrite(input), init)
    if (input instanceof URL) return realFetch(rewrite(input.href), init)
    return realFetch(input, init)
  }) as typeof fetch
}
