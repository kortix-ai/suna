---
recorded: 2026-09-14T22:56:25Z
incident_date: 2026-09-14
commit: 081d54e20a
---
# Every desktop screen needs an exit, and web history steps in Electron go through the shell

**When:** adding a full-screen web surface, or navigating history from web code
inside the desktop shell. (1) The shell has no toolbar: never ship a screen
whose only exit is a browser Back. The root layout's `DesktopBackButton` is
on by default; a shell that navigates opts out with `data-kx-titlebar-owner`.
(2) A renderer `history.back()` DOES fire Electron's `will-navigate`; the gate
cancels a step into a non-app entry and opens it in the system browser, so
the window does not move. Step through `window.kortixDesktop.navigate`.
*Incident:* `/new` soft-locked desktop users (report 2026-09-14); #7200's
"`will-navigate` does not run for traversal" was false — native journey 27
showed Back on `/oauth/authorize` doing nothing and `shell.openExternal
(/favicon.png)`. *Enforcer:* `27-desktop-parity.spec.ts` (web, desktop UA,
`E2E_DESKTOP_NATIVE=1`), `desktop-back-button.test.tsx`, `navigation.test.js`.
