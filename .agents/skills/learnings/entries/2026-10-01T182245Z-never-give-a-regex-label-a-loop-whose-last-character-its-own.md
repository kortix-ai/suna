---
recorded: 2026-10-01T18:22:45Z
incident_date: 2026-10-01
---
# Never give a regex label a loop whose last character its own class also matches: Hermes backtracks through every split

**Rule:** In any regex that runs on chat text and ships to mobile, make every
repeated piece parse one way. `[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.`
lets the loop and its last character split a run many ways; write
`[a-zA-Z0-9][a-zA-Z0-9-]{0,62}\.` and check the rest after the match. Time a new
pattern under Hermes (the app on a device or emulator), not only under V8: V8
(web, `bun test`) does not show this.

**Trigger surface:** Editing `packages/shared/src/utils/url-autolink.ts` or any
regex that `TextPartBlock`, markdown, or file previews run on message text.

**Incident:** 2026-10-01. The production mobile app froze on a session whose
computer was waking: the saved-copy view (`SessionConnecting` → `SavedThread`)
renders every saved text part at once, and `autoLinkUrls` took 19.8 s on one
ordinary 3.8k-character agent reply under Hermes, then threw
`RangeError: Maximum regex stack depth reached`. The JS thread was blocked, so
the floating menu button and every drawer link did nothing. The bare-domain
branch alone took 14.2 s; the `https://` branch took 0 ms. After the fix the same
21 parts take 39 ms in total.

**Enforcement:** none yet: a Hermes-run timing check over `SESSION_FIXTURE`'s
text parts (the bun suite runs V8 and cannot catch it).
