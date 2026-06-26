# Browser QA Workflow

Use this reference when a web task needs interactive browser QA, screenshots, or functional testing.

## Preferred Setup

- Use `pty_spawn` for any dev server, preview server, or other long-running process.
- Use the `agent-browser` skill for browser automation, screenshots, clicks, typing, and verification.
- Keep one running server session and reuse it across edits instead of restarting it after every change.

## Core Workflow

1. List the user-visible requirements and the claims you expect to make in the final answer.
2. Start the site locally with `pty_spawn` (for example `npm run dev`, `vite`, or `python3 -m http.server 3000`).
3. Open the local URL in the browser automation flow and verify desktop first, then mobile.
4. Run functional checks with real interactions: navigation, forms, toggles, hover states, and key end-to-end flows.
5. Run a separate visual QA pass for hierarchy, spacing, overflow, contrast, responsiveness, and broken states.
6. Capture screenshots only after the current state is the one you are signing off on.
7. Fix issues, reload the page, and repeat until the implemented experience matches the intended one.

## QA Checklist

- Verify the primary user flow end-to-end.
- Verify all meaningful controls at least once.
- Verify at least one error, empty, or edge state when relevant.
- Verify desktop and mobile layouts.
- Verify post-interaction states, not just the initial view.
- Verify that visuals support the claims you plan to make in the final response.

## Server Handling

- Use `pty_spawn` with a clear title and `notifyOnExit=true`.
- Use `pty_read` to inspect logs instead of restarting blindly.
- Only restart a server if it actually crashed or the command changed.
- Use `pty_kill` to stop a server cleanly when the task is done.

## Notes

- Prefer `127.0.0.1` over `localhost` if a tool behaves differently with loopback resolution.
- For SPAs, verify route transitions, refresh behavior, and deep links when applicable.
- For animation-heavy interfaces, inspect at least one in-transition state in addition to the settled states.
