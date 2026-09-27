---
recorded: 2026-09-08T17:17:59Z
incident_date: 2026-09-08
commit: d36a8903b4
---
# Bind native commands to the configured frontend and its main frame

**When:** changing desktop frontend selection, navigation, or native commands.
Trust the configured frontend's exact HTTP(S) origin and the main window's
main frame. Do not substitute a hostname suffix or inherit another frame's URL.
*Incident:* the desktop preview rendered every pane, but its zoom stayed at 1
because the native bridge rejected the selected preview origin.
*Enforcers:* `native-sender.test.js` and native `27-desktop-parity.spec.ts` cover
configured origins, stale origins, missing/child frames, and other windows.
