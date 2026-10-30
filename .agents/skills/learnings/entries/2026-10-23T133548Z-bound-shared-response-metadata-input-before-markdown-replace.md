---
recorded: 2026-10-23T13:35:48Z
incident_date: 2026-10-23
---
# Bound shared-response metadata input before markdown replacements

**Rule:** Limit markdown metadata input before applying link replacements. Limit response titles before applying the same replacements.

**Trigger surface:** Rendering metadata or titles from assistant-generated response text.

**Incident:** PR #10816 parsed an entire 256 KiB response for a 160-character excerpt. A bracket-only response took 24,200 ms. Restricting the parser to 4,000 characters reduced the regression case to 7.57 ms before merge.

**Enforcement:** The shared-response page's `public-response.test.ts` asserts the 256 KiB bracket case completes within 100 ms.
