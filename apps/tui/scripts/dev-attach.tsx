/**
 * Live harness for attach mode (SPEC §5.11). Not a unit test: it needs a real
 * API, a real session, and the version-matched `opencode` binary, so `bun
 * test` never runs it.
 *
 * Run it under a pseudo-terminal — `opencode attach` inherits stdio and needs
 * a controlling tty, and so does the OpenTUI renderer:
 *
 *   KORTIX_API_URL=http://localhost:17408 KORTIX_API_KEY=<jwt> \
 *   KORTIX_PROJECT_ID=<pid> KORTIX_SESSION_ID=<sid> \
 *   PTY_OUT=/tmp/attach.bin python3 <the wrapper below> bun run scripts/dev-attach.tsx
 *
 * Shape: one component owns the attach, the way the app will — mount, paint,
 * `runAttach`, repaint. The marker label is component STATE, not a second
 * `root.render()` call: a second `render()` on the same root is a no-op under
 * `@opentui/react` 0.5.11, so a label changed that way never repaints.
 *
 * The captured byte stream is the proof. Measured against a live Platinum
 * sandbox:
 *
 *   ESC[?1049h            the Kortix TUI entered the alternate screen
 *   KORTIX-TUI-BEFORE 0
 *   ESC[?1049l            suspend() LEFT it, before opencode started
 *   Resolving session … / OpenCode binary ready … / Local OpenCode proxy …
 *   ESC[?1049h            opencode entered it
 *   ESC[?1049l            opencode left it on exit
 *   ESC[?1049h            resume() re-entered it
 *   KORTIX-TUI-AFTER n    the Kortix TUI painted a NEW frame (n > 0)
 *   ESC[?1049l            destroy() on shutdown
 *
 * The wrapper sends the quit keys — this process reads the tty, it cannot
 * write to it. macOS `script` cannot stand in: it gives the child no
 * controlling tty on stdin. opencode does NOT quit on a bare `q` (that types
 * into its composer); Escape then Ctrl+C does.
 *
 *   import os, pty, select, struct, subprocess, sys, termios, fcntl, time
 *   mfd, sfd = pty.openpty()
 *   fcntl.ioctl(sfd, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 120, 0, 0))
 *   p = subprocess.Popen(sys.argv[1:], stdin=sfd, stdout=sfd, stderr=sfd,
 *                        close_fds=True, preexec_fn=os.setsid,
 *                        env={**os.environ, 'TERM': 'xterm-256color'})
 *   os.close(sfd)
 *   # drain mfd into a buffer; at ATTACH_HOLD_MS write b'\x1b', then b'\x03';
 *   # on child exit write the buffer to PTY_OUT and scan it for the sequences.
 */

import { createCliRenderer } from '@opentui/core';
import { createRoot } from '@opentui/react';
import { useEffect, useState } from 'react';

import { resolveHost } from '../src/auth/hosts.ts';
import { attachResultToast } from '../src/features/attach/attach-status.tsx';
import {
  type AttachStatus,
  type RunAttachResult,
  runAttach,
} from '../src/features/attach/attach.ts';
import { initKortix } from '../src/kortix.ts';

/** Paint time before and after, so both markers land in the byte stream. */
const PAINT_MS = Number(process.env.ATTACH_PAINT_MS ?? 1_200);

const host = resolveHost();
if (!host) throw new Error('no host: set KORTIX_API_URL + KORTIX_API_KEY');
initKortix(host);

const projectId = process.env.KORTIX_PROJECT_ID?.trim();
const sessionId = process.env.KORTIX_SESSION_ID?.trim();
if (!projectId || !sessionId) throw new Error('set KORTIX_PROJECT_ID and KORTIX_SESSION_ID');

const statuses: AttachStatus[] = [];
let finished: (result: RunAttachResult) => void = () => {};
const done = new Promise<RunAttachResult>((resolve) => {
  finished = resolve;
});

const renderer = await createCliRenderer({ exitOnCtrlC: false, targetFps: 15 });

function Probe() {
  // The ticker makes every frame unique, so a repaint after `resume()` is
  // distinguishable from a terminal that merely restored its old buffer.
  const [tick, setTick] = useState(0);
  const [returned, setReturned] = useState(false);

  useEffect(() => {
    const timer = setInterval(() => setTick((value) => value + 1), 250);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    void (async () => {
      await new Promise((resolve) => setTimeout(resolve, PAINT_MS));
      const result = await runAttach({
        renderer,
        host: host as NonNullable<typeof host>,
        projectId: projectId as string,
        sessionId: sessionId as string,
        onStatus: (status) => statuses.push(status),
      });
      setReturned(true);
      setTimeout(() => finished(result), PAINT_MS);
    })();
  }, []);

  // Two lines, not one relabelled line. The renderer writes CELL DIFFS, so
  // changing `BEFORE` to `AFTER` in place emits `ESC[3;14H…AFTE` and the
  // marker never appears whole in the byte stream. A line that was blank
  // paints in full.
  return (
    <box border borderStyle="single" title="Kortix TUI" padding={1} flexDirection="column">
      <text>{`KORTIX-TUI-BEFORE ${tick}`}</text>
      <text>{returned ? `KORTIX-TUI-AFTER ${tick}` : ' '}</text>
    </box>
  );
}

const root = createRoot(renderer);
root.render(<Probe />);

const result = await done;

root.unmount();
renderer.destroy();

// Only now, with the renderer gone, is plain stdout the terminal again.
process.stdout.write(`\nATTACH-STAGES ${statuses.map((s) => s.stage).join(',')}\n`);
process.stdout.write(`ATTACH-RESULT ${JSON.stringify(result)}\n`);
process.stdout.write(`ATTACH-TOAST ${attachResultToast(result).message}\n`);
process.exit('error' in result ? 1 : 0);
