Stuck sandboxes recover

Sessions recover a stuck sandbox and a stale runtime on their own.

## Fixed

- A session whose sandbox name was still held by an old archived sandbox could never get a new sandbox. It now provisions under a fresh name.
- Opening a session repairs a stale runtime immediately instead of waiting for the background check.
- A prompt parked while the sandbox restarts keeps its sandbox deadline through every retry.
- A Firefox browser-extension error no longer reaches error reporting.

