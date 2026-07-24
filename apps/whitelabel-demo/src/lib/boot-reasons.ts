/**
 * Session-start failure reasons arrive as server codes (snake_case) or raw
 * error strings. Users should never read `runtime_identity_unavailable` in
 * 12px red text — map the known codes to plain language and fall back to a
 * de-snaked sentence, keeping the raw code available as a detail line.
 */

export interface BootFailure {
  title: string;
  hint: string;
  /** The raw server code, shown small for support/debugging. */
  code: string | null;
}

const KNOWN: Record<string, Omit<BootFailure, 'code'>> = {
  runtime_identity_unavailable: {
    title: "The session's runtime can't be found",
    hint: 'Its sandbox was likely reclaimed while stopped. Try again to provision a fresh one.',
  },
  provision_failed: {
    title: 'Provisioning failed',
    hint: 'The sandbox could not be created. Try again; if it keeps failing, check the project sandbox health in settings.',
  },
  boot_timeout: {
    title: 'The runtime took too long to start',
    hint: 'This is usually transient. Try again.',
  },
  quota_exceeded: {
    title: 'Sandbox limit reached',
    hint: 'Stop an idle session or raise the account limit, then try again.',
  },
};

const CODE_RE = /^[a-z0-9]+(_[a-z0-9]+)+$/;

export function humanizeBootReason(reason: string | null | undefined): BootFailure {
  const raw = reason?.trim() ?? '';
  if (!raw) {
    return { title: 'The session could not start', hint: 'Try again.', code: null };
  }
  const known = KNOWN[raw];
  if (known) return { ...known, code: raw };
  if (CODE_RE.test(raw)) {
    const sentence = raw.replaceAll('_', ' ');
    return {
      title: sentence.charAt(0).toUpperCase() + sentence.slice(1),
      hint: 'Try again; if it keeps failing this code will help support.',
      code: raw,
    };
  }
  return { title: raw, hint: 'Try again.', code: null };
}
