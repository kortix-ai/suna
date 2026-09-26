// ─────────────────────────────────────────────────────────────────────────────
// "Am I a binary the platform owns?"
//
// Inside a managed Kortix sandbox the platform — not the CLI — decides which
// `kortix` and which `opencode` exist. The daemon converges both against a
// signed manifest (kortix-sandbox-agent-server runtime-assets.ts), and the
// image pins OpenCode's own autoupdate off. A CLI that fetches its own
// replacement from a PUBLIC release, or pulls a 40 MB OpenCode tarball from
// registry.npmjs.org, breaks that ownership in a way the platform cannot heal:
// kortix.com/install writes ~/.local/bin/kortix, which is FIRST on the image
// PATH, while runtime-assets only ever converges /usr/local/bin/kortix.
//
// The signal is `KORTIX_SUPERVISED=1`, exported unconditionally by
// apps/sandbox/entrypoint.sh before it execs the daemon. Every descendant
// inherits it, including the Session terminal's PTY (routes/pty.ts builds the
// shell env from `process.env`). Outside a sandbox it is simply absent, so a
// developer's own machine is untouched.
//
// Same predicate as the daemon's `detectSupervised` (cli.ts), minus the
// binary-path fallbacks that only make sense for kortixd. The daemon is a
// separately built app with its own lock file, so the check is stated twice on
// purpose rather than crossing that boundary for four lines.
// ─────────────────────────────────────────────────────────────────────────────

/** True inside a sandbox whose binaries the platform converges. */
export function isSupervised(): boolean {
  return (process.env.KORTIX_SUPERVISED ?? '').trim() === '1';
}

/** One sentence, used wherever a supervised refusal has to explain itself. */
export const SUPERVISED_NOTICE =
  'This sandbox is platform-managed: Kortix converges the `kortix` and `opencode` binaries itself.';
