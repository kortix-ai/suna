---
recorded: 2026-09-14T23:25:03Z
incident_date: 2026-09-14
commit: 393d4e5fc5
---
# Establish browser readiness before measuring navigation or capturing fonts

**When:** measuring document reloads or taking UI screenshots. Await the initial
load before recording its baseline. Select destination links by their exact href;
await font readiness before screenshot capture within the journey deadline.
*Incident:* PR #7240 local Chromium counted a late boot load as a menu reload,
clicked before the agent card appeared, and timed out during a 46-second cold font load.
*Enforcers:* browser journeys 24 and 27 retain navigation, layout, and screenshot assertions.
